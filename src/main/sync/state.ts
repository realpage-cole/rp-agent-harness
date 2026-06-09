/**
 * Shared-state sync (Phase 3) for the SyncManager module — the hive's roster
 * (registry.json), task kanban (tasks.json), and blackboard (board.md) synced
 * across teammates' machines.
 *
 * This file is PURE TRANSPORT: it knows the Supabase DB schema (the `agents` /
 * `tasks` / `board` tables from migration 0003) but NOT the hive file shapes. All
 * hive<->DB shape mapping + the LAST-WRITER-WINS / ADDITIVE merge live behind the
 * `HiveBridge` (implemented in hive.ts, constructed in index.ts). state.ts NEVER
 * imports hive.ts — it only ever calls `ctx.hive.readStateRows()` (for push) and
 * `ctx.hive.applyStateRows()` (for pull).
 *
 * PUSH rides the existing 60s SyncManager timer. PULL is Supabase Realtime
 * (postgres_changes) PLUS a 30s catch-up poll (realtime can drop). Conflict
 * policy is LAST-WRITER-WINS by `updated_at`, ADDITIVE — never delete a local row
 * on pull; remote overwrites a local row ONLY if `remote.updated_at` is strictly
 * newer. All of that LWW logic lives in `applyStateRows`; this file just moves
 * rows over the wire.
 *
 * Best-effort throughout: nothing here ever throws into SyncManager's timer.
 */
import type { StateSyncCtx, SupabaseLike } from './types';
import { errMsg } from './io';

// Per-table pull cursors (high-water mark = max updated_at consumed) + the
// last-pushed board stamp (cheap skip of a redundant board upsert).
const K_AGENTS_SINCE = 'sync.state.agents.since';
const K_BOARD_SINCE = 'sync.state.board.since';
const K_BOARD_PUSHED = 'sync.state.board.pushed';

/**
 * Push the hive's shared state up. Stamps workspace_id/machine_id (and a fallback
 * updated_at where the row is missing one — the hive owns the real stamps, this is
 * only a floor) onto `ctx.hive.readStateRows()` output and upserts into the
 * `agents` / `tasks` / `board` tables. Empty tables are skipped; the board is
 * skipped when its `updated_at` matches the last one we pushed (cheap dedup via kv).
 * Each table is independent + best-effort — one failing never blocks the others,
 * and a failure simply contributes 0 (the next beat retries).
 * @returns the number of rows upserted this pass (0 on no-op/error).
 */
export async function pushState(ctx: StateSyncCtx): Promise<number> {
  let rows: ReturnType<StateSyncCtx['hive']['readStateRows']>;
  try {
    rows = ctx.hive.readStateRows();
  } catch {
    return 0;
  }

  const now = Date.now();
  let pushed = 0;

  // ─── agents (onConflict workspace_id,agent_id) ──────────────────────────────
  const agents = (rows.agents ?? []).map((r) => stamp(r, ctx, now));
  if (agents.length > 0) {
    if (!(await upsert(ctx.client, 'agents', agents, 'workspace_id,agent_id'))) {
      pushed += agents.length;
    }
  }

  // ─── tasks (onConflict workspace_id,task_id) ────────────────────────────────
  // Tagged with owner_label (the owner's signed-in email) so a teammate's board
  // can be listed + viewed on demand. We PUSH our own tasks but never merge a
  // teammate's back into the local board (see hive.applyStateRows).
  const tasks = (rows.tasks ?? []).map((r) => ({
    ...stamp(r, ctx, now),
    owner_label: ctx.ownerLabel ?? null
  }));
  if (tasks.length > 0) {
    if (!(await upsert(ctx.client, 'tasks', tasks, 'workspace_id,task_id'))) {
      pushed += tasks.length;
    }
  }

  // ─── board (onConflict workspace_id) — skip when unchanged since last push ──
  const board = rows.board;
  if (board && typeof board.body === 'string') {
    const updatedAt = typeof board.updated_at === 'number' ? board.updated_at : now;
    const lastPushed = ctx.store.getKv<number>(K_BOARD_PUSHED);
    if (lastPushed !== updatedAt) {
      const boardRow: Record<string, unknown> = {
        workspace_id: ctx.workspaceId,
        body: board.body,
        updated_by: ctx.machineId,
        updated_at: updatedAt
      };
      if (!(await upsert(ctx.client, 'board', [boardRow], 'workspace_id'))) {
        ctx.store.setKv(K_BOARD_PUSHED, updatedAt);
        pushed += 1;
      }
    }
  }

  return pushed;
}

/**
 * One catch-up pull pass: SELECT agents/tasks/board for this workspace updated
 * since the per-table kv cursors, map DB rows back to domain rows (strip
 * workspace_id/machine_id, keep the DB `updated_at`), and hand them to
 * `ctx.hive.applyStateRows()` (which merges LWW + ADDITIVE, then
 * atomicWriteJson + commit). Advances each cursor to the max updated_at consumed
 * for that table. Backs the 30s poll that covers dropped realtime events.
 * @returns the number of remote rows applied locally this pass (0 on no-op/error).
 */
export async function pullStateOnce(ctx: StateSyncCtx): Promise<number> {
  const agentsSince = ctx.store.getKv<number>(K_AGENTS_SINCE) ?? 0;
  const boardSince = ctx.store.getKv<number>(K_BOARD_SINCE) ?? 0;

  // NOTE: tasks are deliberately NOT pulled into the merge — each machine keeps
  // its own board (a teammate's kanban is viewed on demand, not merged). Only the
  // roster (agents) + blackboard (board) are reconciled here.
  const agentsRaw = await select(ctx.client, 'agents', ctx.workspaceId, agentsSince);
  const boardRaw = await select(ctx.client, 'board', ctx.workspaceId, boardSince);

  const agents = agentsRaw.map(toDomainRow);
  const board = boardRow(boardRaw);

  const applied = agents.length + (board ? 1 : 0);
  if (applied === 0) return 0;

  try {
    ctx.hive.applyStateRows({ agents, board });
  } catch {
    // The merge is best-effort; leave the cursors so the next pass retries.
    return 0;
  }

  // Only advance cursors AFTER a successful apply, each to the max stamp seen.
  advanceCursor(ctx, K_AGENTS_SINCE, agentsSince, agentsRaw);
  advanceCursor(ctx, K_BOARD_SINCE, boardSince, boardRaw);

  return applied;
}

/**
 * Open the Supabase Realtime channel(s) for postgres_changes on the shared-state
 * tables (one channel per table, filtered to this workspace) and apply each change
 * via `ctx.hive.applyStateRows()` (mapping the single `payload.new` row). Calls
 * `onApplied` whenever a remote change is applied locally so SyncManager can refresh
 * status. Best-effort: if realtime setup throws, returns a no-op unsubscribe — the
 * 30s catch-up poll still covers everything.
 * @returns an unsubscribe handle that removeChannel()s every channel opened.
 */
export function subscribeState(ctx: StateSyncCtx, onApplied: () => void): () => void {
  const channels: ReturnType<SupabaseLike['channel']>[] = [];
  const filter = `workspace_id=eq.${ctx.workspaceId}`;

  // Apply a single realtime row for one table, then notify. Best-effort: a bad
  // payload or a throwing merge is swallowed (the 30s catch-up will reconcile).
  const applyOne = (table: 'agents' | 'board', fresh?: Record<string, unknown>): void => {
    if (!fresh) return;
    try {
      if (table === 'agents') {
        ctx.hive.applyStateRows({ agents: [toDomainRow(fresh)] });
      } else {
        const b = boardRow([fresh]);
        if (!b) return;
        ctx.hive.applyStateRows({ board: b });
      }
    } catch {
      return; // catch-up poll reconciles
    }
    onApplied();
  };

  // tasks are intentionally NOT subscribed: a teammate's kanban is viewed on
  // demand, never merged into the local board.
  try {
    for (const table of ['agents', 'board'] as const) {
      const ch = ctx.client
        .channel(`state:${ctx.workspaceId}:${table}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table, filter },
          (payload) => applyOne(table, payload.new)
        )
        .subscribe();
      channels.push(ch);
    }
  } catch (e) {
    // Setup failed — tear down whatever opened and fall back to the poll.
    void errMsg(e);
    for (const ch of channels) {
      try { ctx.client.removeChannel(ch); } catch { /* best-effort */ }
    }
    return () => { /* no-op: realtime unavailable, catch-up poll covers it */ };
  }

  return () => {
    for (const ch of channels) {
      try { ctx.client.removeChannel(ch); } catch { /* best-effort */ }
    }
  };
}

// ─── helpers ───────────────────────────────────────────────────────────────

/** Stamp a domain row with workspace_id/machine_id and an updated_at FALLBACK
 *  (only when the hive didn't supply one — the hive owns the real LWW stamp). */
function stamp(row: Record<string, unknown>, ctx: StateSyncCtx, now: number): Record<string, unknown> {
  return {
    ...row,
    workspace_id: ctx.workspaceId,
    machine_id: ctx.machineId,
    updated_at: typeof row.updated_at === 'number' ? row.updated_at : now
  };
}

/** SELECT this workspace's rows for `table` updated strictly after `since`.
 *  Best-effort: any client/server error yields [] (the cursor stays put). */
async function select(
  client: SupabaseLike,
  table: string,
  workspaceId: string,
  since: number
): Promise<Record<string, unknown>[]> {
  try {
    const { data, error } = await client
      .from(table)
      .select('*')
      .eq('workspace_id', workspaceId)
      .gt('updated_at', since);
    if (error || !data) return [];
    return data;
  } catch {
    return [];
  }
}

/** Strip the transport columns (workspace_id/machine_id) so the hive sees only
 *  domain fields; the DB `updated_at` is kept as-is (it's the LWW key). */
function toDomainRow(row: Record<string, unknown>): Record<string, unknown> {
  const { workspace_id: _ws, machine_id: _m, created_at: _c, ...rest } = row;
  void _ws; void _m; void _c;
  return rest;
}

/** Map the (0-or-1-row) board select into the domain board shape, or null. */
function boardRow(rows: Record<string, unknown>[]): { body: string; updated_at: number } | null {
  const row = rows[0];
  if (!row) return null;
  const body = typeof row.body === 'string' ? row.body : null;
  if (body === null) return null;
  return { body, updated_at: typeof row.updated_at === 'number' ? row.updated_at : 0 };
}

/** Advance a pull cursor to the max `updated_at` across the fetched rows, never
 *  backwards. No-op when nothing moved it past `since`. */
function advanceCursor(
  ctx: StateSyncCtx,
  key: string,
  since: number,
  rows: Record<string, unknown>[]
): void {
  let max = since;
  for (const r of rows) {
    const u = typeof r.updated_at === 'number' ? r.updated_at : 0;
    if (u > max) max = u;
  }
  if (max > since) ctx.store.setKv(key, max);
}

/** Upsert with dedup-on-conflict. Returns an error string on failure, null on
 *  success. Best-effort: a thrown client error becomes a string, never propagates. */
async function upsert(
  client: SupabaseLike,
  table: string,
  rows: unknown[],
  conflictKey: string
): Promise<string | null> {
  try {
    const { error } = await client.from(table).upsert(rows, { onConflict: conflictKey });
    return error ? error.message : null;
  } catch (e) {
    return errMsg(e);
  }
}

// ─── teammate-board read path (the kanban toggle) ────────────────────────────

/** A teammate's task board, identified by their origin machine + friendly label. */
export interface TaskBoardOwner {
  machineId: string;
  ownerLabel: string | null;
}

/** List the distinct task-board owners in this workspace (machine_id + owner_label),
 *  EXCLUDING this machine — the teammates whose kanbans you can switch to. Dedupes
 *  in JS (PostgREST has no clean DISTINCT). Best-effort: any error yields []. */
export async function listTaskOwners(
  client: SupabaseLike,
  workspaceId: string,
  excludeMachineId: string
): Promise<TaskBoardOwner[]> {
  try {
    const { data, error } = await client
      .from('tasks')
      .select('machine_id, owner_label')
      .eq('workspace_id', workspaceId)
      .neq('machine_id', excludeMachineId);
    if (error || !data) return [];
    const seen = new Map<string, string | null>();
    for (const row of data) {
      const mid = typeof row.machine_id === 'string' ? row.machine_id : null;
      if (!mid || seen.has(mid)) continue;
      seen.set(mid, typeof row.owner_label === 'string' ? row.owner_label : null);
    }
    return [...seen.entries()].map(([machineId, ownerLabel]) => ({ machineId, ownerLabel }));
  } catch {
    return [];
  }
}

/** Fetch a teammate's task cards (the full payloads) for READ-ONLY viewing.
 *  Returns the same `{ tasks: [...] }` shape as window.cth.hiveTasks(), so the
 *  renderer reuses its existing parser. Best-effort: any error yields no tasks. */
export async function fetchTeammateTasks(
  client: SupabaseLike,
  workspaceId: string,
  machineId: string
): Promise<{ tasks: unknown[] }> {
  try {
    const { data, error } = await client
      .from('tasks')
      .select('payload')
      .eq('workspace_id', workspaceId)
      .eq('machine_id', machineId);
    if (error || !data) return { tasks: [] };
    const tasks = data.map((r) => r.payload).filter((p) => p && typeof p === 'object');
    return { tasks };
  } catch {
    return { tasks: [] };
  }
}
