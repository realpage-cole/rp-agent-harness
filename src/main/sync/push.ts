/**
 * Append-only push (Phase 1: one-way UP) for the SyncManager module — moved
 * verbatim from the original single-file `sync.ts`, refactored from instance
 * methods into a single pure-ish entrypoint `pushAppendOnly(ctx)` that takes its
 * dependencies (client, store, ids, hive root) explicitly so SyncManager owns
 * the lifecycle/serialization and this file owns only the push mechanics.
 *
 * Tails the three append-only sinks and INSERTs new rows into Supabase. Zero
 * merge logic — these are the only stores that need none:
 *   - <hive>/log.jsonl         → public.hive_log
 *   - <hive>/cost-ledger.jsonl → public.cost_ledger   (row already snake_case)
 *   - SQLite command_history   → public.command_history
 *
 * Idempotency: every pushed row carries a deterministic uid (machineId + line/id
 * content hash) and we upsert with `ignoreDuplicates`, so a re-push after a crash
 * or offset reset can never double-insert. Cursors (byte offsets + the last-synced
 * history id) live in the SQLite kv store, so they survive restarts.
 *
 * Each sink is independent and best-effort: one failing doesn't block the others,
 * and a failure leaves that sink's cursor unadvanced so the next tick retries from
 * the same spot.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandHistoryRow } from '../db';
import {
  type AppendPushCtx,
  K_OFF_LOG,
  K_OFF_COST,
  K_CUR_HISTORY,
  MAX_HISTORY_ROWS
} from './types';
import { readNewLines, uid, errMsg } from './io';

/** Running tally of what each sink pushed in this pass — returned to SyncManager,
 *  which accumulates it into SyncStatus.pushed. */
interface PushCounts { log: number; cost: number; history: number }

/**
 * One push pass over all three sinks. Best-effort throughout: it never throws —
 * a per-sink failure is recorded on `ctx.store`'s cursors (by NOT advancing them)
 * and surfaced via the returned counts (the failing sink simply contributes 0).
 * SyncManager serializes calls and records lastError/lastPushAt around this.
 */
export async function pushAppendOnly(ctx: AppendPushCtx): Promise<PushCounts> {
  const counts: PushCounts = { log: 0, cost: 0, history: 0 };
  counts.log += await pushJsonlTail(ctx, 'log.jsonl', K_OFF_LOG, 'hive_log', 'event_uid',
    (line) => logRow(line, ctx.machineId, ctx.workspaceId));
  counts.cost += await pushJsonlTail(ctx, 'cost-ledger.jsonl', K_OFF_COST, 'cost_ledger', 'event_uid',
    (line) => costRow(line, ctx.machineId, ctx.workspaceId));
  counts.history += await pushHistory(ctx);
  return counts;
}

/** Tail one append-only jsonl under the hive root from a stored byte offset,
 *  map each complete line to a row, upsert (dedup on `conflictKey`), and only
 *  advance the offset on a clean insert. `rowFor` returns null to skip a line
 *  (unparseable / empty). Returns how many rows were pushed (0 on no-op/error). */
async function pushJsonlTail(
  ctx: AppendPushCtx,
  file: string,
  offsetKey: string,
  table: string,
  conflictKey: string,
  rowFor: (line: string) => Record<string, unknown> | null
): Promise<number> {
  const path = join(ctx.hiveRoot, file);
  if (!existsSync(path)) return 0;

  let size = 0;
  try { size = statSync(path).size; } catch { return 0; }
  let offset = ctx.store.getKv<number>(offsetKey) ?? 0;
  if (!Number.isFinite(offset) || offset < 0 || offset > size) offset = 0; // rotated/truncated → resync (dedup makes it safe)
  if (offset >= size) return 0; // nothing new

  const read = readNewLines(path, offset, size);
  if (!read || read.lines.length === 0) return 0; // only a partial trailing line so far

  const rows = read.lines.map(rowFor).filter((r): r is Record<string, unknown> => r !== null);
  if (rows.length === 0) {
    // All lines were unparseable, but they ARE consumed — advance past them.
    ctx.store.setKv(offsetKey, read.nextOffset);
    return 0;
  }

  const err = await upsert(ctx, table, rows, conflictKey);
  if (err) return 0; // leave offset; retry next tick (SyncManager surfaces the error)
  ctx.store.setKv(offsetKey, read.nextOffset);
  return rows.length;
}

/** Push net-new command_history rows (id-ordered) and advance the id cursor.
 *  Returns how many rows were pushed (0 on no-op/error). */
async function pushHistory(ctx: AppendPushCtx): Promise<number> {
  const last = ctx.store.getKv<number>(K_CUR_HISTORY) ?? 0;
  let rows: CommandHistoryRow[];
  try { rows = ctx.store.historySince(last, MAX_HISTORY_ROWS); } catch { return 0; }
  if (rows.length === 0) return 0;

  const machine = ctx.machineId;
  const payload = rows.map((r) => ({
    row_uid: `${machine}:ch:${r.id}`,
    workspace_id: ctx.workspaceId,
    machine_id: machine,
    source_id: r.id,
    agent_id: r.agentId,
    cwd: r.cwd,
    text: r.text,
    ts: r.ts
  }));

  const err = await upsert(ctx, 'command_history', payload, 'row_uid');
  if (err) return 0;
  const maxId = rows.reduce((m, r) => (r.id > m ? r.id : m), last);
  ctx.store.setKv(K_CUR_HISTORY, maxId);
  return rows.length;
}

// ─── row mappers ─────────────────────────────────────────────────────────────

/** log.jsonl line → hive_log row. The line is `{ ts, ...event }` (hive.ts
 *  appendLog), so we keep the whole object as `event` and lift `ts`. */
function logRow(line: string, machine: string, workspaceId: string): Record<string, unknown> | null {
  let parsed: { ts?: number };
  try { parsed = JSON.parse(line); } catch { return null; }
  return {
    event_uid: uid(machine, line),
    workspace_id: workspaceId,
    machine_id: machine,
    ts: typeof parsed.ts === 'number' ? parsed.ts : null,
    event: parsed
  };
}

/** cost-ledger.jsonl line → cost_ledger row. The on-disk row is already fully
 *  snake_case (hive.ts appendCostLedger), so we spread it 1:1 and tag it. */
function costRow(line: string, machine: string, workspaceId: string): Record<string, unknown> | null {
  let row: Record<string, unknown>;
  try { row = JSON.parse(line); } catch { return null; }
  return { event_uid: uid(machine, line), workspace_id: workspaceId, machine_id: machine, ...row };
}

/** Upsert with dedup. Returns an error string on failure, null on success.
 *  Best-effort: a thrown client error becomes a string, never propagates. */
async function upsert(
  ctx: AppendPushCtx,
  table: string,
  rows: unknown[],
  conflictKey: string
): Promise<string | null> {
  try {
    const { error } = await ctx.client.from(table).upsert(rows, {
      onConflict: conflictKey,
      ignoreDuplicates: true
    });
    return error ? error.message : null;
  } catch (e) {
    return errMsg(e);
  }
}
