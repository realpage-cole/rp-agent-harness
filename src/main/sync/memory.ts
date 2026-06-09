/**
 * Agent-memory sync (Phase 2) for the SyncManager module.
 *
 * Semantics (one-agent-one-machine; NO merge needed):
 *   pushMemory — scan `<home>/hive/agents/<id>/memory.md` (OWNED agents). For each,
 *     hash the body; if it changed since last push (kv cursor), upsert an
 *     agent_memory row keyed on (workspace_id, agent_id). Returns total upserted.
 *   pullMemory — select teammates' agent_memory rows newer than the pull cursor and
 *     write each body to `<home>/hive/mirror/agents/<agentId>/memory.md` only when it
 *     differs on disk (avoid mtime churn). Returns the agentIds written so the caller
 *     can re-mine + emit.
 *
 * Push scans `agents/`, pull writes `mirror/agents/` — DISJOINT, so no echo loop.
 *
 * Best-effort throughout: a per-agent IO/network failure is swallowed (the cursor
 * for that agent simply isn't advanced, so the next tick retries) and nothing here
 * ever throws into SyncManager's timer.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { MemorySyncCtx, SupabaseLike } from './types';
import { chunkMemory } from '../memory/chunk';
import { vectorLiteral } from '../memory/ollama';

/** kv cursor prefix: last-pushed body hash per owned agent (`sync.mem.push.<id>`). */
const K_PUSH_PREFIX = 'sync.mem.push.';
/** kv cursor prefix: last-EMBEDDED body hash per owned agent. Independent of the
 *  text-push cursor so a transient Ollama outage never blocks text sync (and vice
 *  versa) — each retries on its own next tick. */
const K_EMBED_PREFIX = 'sync.mem.embed.';
/** kv cursor: high-water mark (max updated_at) consumed by the last pull. */
const K_PULL_SINCE = 'sync.mem.pullSince';

/** sha1 of an agent's memory body — the content fingerprint we de-dup pushes on
 *  and compare mirror writes against. */
function sha1(body: string): string {
  return createHash('sha1').update(body).digest('hex');
}

/** Best-effort read of registry.json so we can stamp a human name on a pushed row.
 *  Returns an empty map on any error — name is purely cosmetic, never required. */
function readNames(hiveRoot: string): Record<string, string> {
  try {
    const raw = readFileSync(join(hiveRoot, 'registry.json'), 'utf8');
    const reg = JSON.parse(raw) as { agents?: Record<string, { name?: string }> };
    const out: Record<string, string> = {};
    for (const [id, a] of Object.entries(reg.agents ?? {})) {
      if (a && typeof a.name === 'string') out[id] = a.name;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Push owned agents' memory.md bodies to Supabase. For each agent under
 * `<home>/hive/agents/<id>/memory.md` whose body hash differs from the per-agent
 * kv cursor, upsert one agent_memory row (onConflict workspace_id,agent_id) and,
 * on success, advance that agent's cursor. Disjoint from pull (which writes
 * `mirror/agents/`), so a pushed body never re-enters as a "remote" change.
 * @returns the number of agent_memory rows upserted this pass (0 on no-op/error).
 */
export async function pushMemory(ctx: MemorySyncCtx): Promise<number> {
  const hiveRoot = join(ctx.home, 'hive');
  const agentsDir = join(hiveRoot, 'agents');
  if (!existsSync(agentsDir)) return 0;

  let ids: string[];
  try { ids = readdirSync(agentsDir); } catch { return 0; }

  const names = readNames(hiveRoot);
  let pushed = 0;
  for (const id of ids) {
    const mem = join(agentsDir, id, 'memory.md');
    if (!existsSync(mem)) continue;
    let body: string;
    try { body = readFileSync(mem, 'utf8'); } catch { continue; }

    const hash = sha1(body);

    // (1) TEXT sync — agent_memory.body, the source of truth. Gated on its own
    //     hash cursor; independent of the embed step below.
    const textKey = K_PUSH_PREFIX + id;
    if (ctx.store.getKv<string>(textKey) !== hash) {
      const row: Record<string, unknown> = {
        workspace_id: ctx.workspaceId,
        agent_id: id,
        machine_id: ctx.machineId,
        body,
        content_hash: hash,
        updated_at: Date.now()
      };
      if (names[id]) row.name = names[id];
      let error: { message: string } | null = null;
      try {
        ({ error } = await ctx.client
          .from('agent_memory')
          .upsert([row], { onConflict: 'workspace_id,agent_id' }));
      } catch {
        error = { message: 'client threw' }; // leave the cursor — retry next tick
      }
      if (!error) {
        ctx.store.setKv(textKey, hash);
        pushed += 1;
      }
    }

    // (2) EMBED sync — chunk + embed this agent's memory locally (Ollama) and
    //     upsert the vectors into the shared memory_chunks index. Gated on its
    //     OWN cursor so an Ollama outage never blocks (or is blocked by) text
    //     sync. Only runs when an embedder is wired in (sync/index.ts).
    if (ctx.embed && ctx.store.getKv<string>(K_EMBED_PREFIX + id) !== hash) {
      await pushAgentChunks(ctx, id, body, hash, names[id]);
    }
  }
  return pushed;
}

/** Replace one agent's chunk vectors in the shared index for a changed memory.md.
 *  chunk → embed (documents) → delete the agent's stale ordinals → insert the
 *  fresh set, advancing the embed cursor only when the whole replace succeeds.
 *  Best-effort: any failure (Ollama down, count mismatch, DB error) returns
 *  without advancing the cursor, so the next push tick retries cleanly. */
async function pushAgentChunks(
  ctx: MemorySyncCtx,
  agentId: string,
  body: string,
  hash: string,
  name?: string
): Promise<void> {
  const chunks = chunkMemory(body);

  // Empty memory: clear any stale vectors, then mark this hash embedded.
  if (chunks.length === 0) {
    if (await deleteAgentChunks(ctx, agentId)) ctx.store.setKv(K_EMBED_PREFIX + agentId, hash);
    return;
  }

  let vectors: number[][] | null;
  try { vectors = await ctx.embed!(chunks); } catch { return; }
  if (!vectors || vectors.length !== chunks.length) return; // Ollama down / shape mismatch

  const now = Date.now();
  const rows = chunks.map((content, i) => ({
    workspace_id: ctx.workspaceId,
    machine_id: ctx.machineId,
    agent_id: agentId,
    chunk_id: String(i),
    name: name ?? null,
    owner_label: ctx.ownerLabel ?? null,
    content,
    content_hash: hash,
    embedding: vectorLiteral(vectors[i]),
    updated_at: now
  }));

  // Clear stale ordinals first (a shorter new memory leaves orphans otherwise),
  // then insert. Advance the cursor only when both land.
  if (!(await deleteAgentChunks(ctx, agentId))) return;
  let error: { message: string } | null = null;
  try {
    ({ error } = await ctx.client
      .from('memory_chunks')
      .upsert(rows, { onConflict: 'workspace_id,machine_id,agent_id,chunk_id' }));
  } catch {
    return;
  }
  if (error) return;
  ctx.store.setKv(K_EMBED_PREFIX + agentId, hash);
}

/** Delete every chunk this machine owns for one agent. Returns true on success
 *  (so the caller knows it's safe to advance the cursor). Best-effort. */
async function deleteAgentChunks(ctx: MemorySyncCtx, agentId: string): Promise<boolean> {
  try {
    const { error } = await ctx.client
      .from('memory_chunks')
      .delete()
      .eq('workspace_id', ctx.workspaceId)
      .eq('machine_id', ctx.machineId)
      .eq('agent_id', agentId);
    return !error;
  } catch {
    return false;
  }
}

/**
 * Pull teammates' agent_memory into the local mirror. Selects rows for this
 * workspace authored by OTHER machines and newer than the pull cursor, then writes
 * each body to `<home>/hive/mirror/agents/<agentId>/memory.md` — but only when the
 * on-disk content actually differs (skip to avoid needless mtime churn that would
 * trigger a redundant re-mine). Advances the pull cursor to the highest updated_at
 * fully consumed this pass — but never past a row that failed to write, so failures
 * are retried on the next tick.
 * @returns the agentIds whose mirror memory.md was (re)written this pass.
 */
export async function pullMemory(ctx: MemorySyncCtx): Promise<string[]> {
  const since = ctx.store.getKv<number>(K_PULL_SINCE) ?? 0;

  let data: Record<string, unknown>[] | null;
  let error: { message: string } | null;
  try {
    ({ data, error } = await ctx.client
      .from('agent_memory')
      .select('agent_id,body,updated_at,machine_id')
      .eq('workspace_id', ctx.workspaceId)
      .neq('machine_id', ctx.machineId)
      .gt('updated_at', since));
  } catch {
    return [];
  }
  if (error || !data || data.length === 0) return [];

  const mirrorDir = join(ctx.home, 'hive', 'mirror', 'agents');
  const written: string[] = [];
  // Rows can arrive in any order (the select isn't ordered), so we can't just
  // ride the max updated_at: a later-timestamped row that succeeds would strand
  // an earlier one that failed to write. Track the highest fully-consumed stamp
  // and the lowest stamp we FAILED to consume, then advance the cursor only as
  // far as is safe (strictly below any failure) so failures are retried.
  let maxConsumed = since;
  let minFailed = Number.POSITIVE_INFINITY;

  for (const row of data) {
    const agentId = typeof row.agent_id === 'string' ? row.agent_id : null;
    const body = typeof row.body === 'string' ? row.body : null;
    const updatedAt = typeof row.updated_at === 'number' ? row.updated_at : 0;

    // A malformed/empty row is still "consumed" — count it toward the cursor so
    // we don't re-fetch it forever, but never write it.
    if (!agentId || body === null) {
      if (updatedAt > maxConsumed) maxConsumed = updatedAt;
      continue;
    }

    const mem = join(mirrorDir, agentId, 'memory.md');
    let current: string | null = null;
    try { if (existsSync(mem)) current = readFileSync(mem, 'utf8'); } catch { current = null; }
    if (current === body) {
      if (updatedAt > maxConsumed) maxConsumed = updatedAt; // already mirrored
      continue; // identical on disk — skip to avoid mtime churn
    }

    try {
      mkdirSync(dirname(mem), { recursive: true });
      writeFileSync(mem, body, 'utf8');
      written.push(agentId);
      if (updatedAt > maxConsumed) maxConsumed = updatedAt;
    } catch {
      if (updatedAt < minFailed) minFailed = updatedAt; // retry on a later tick
    }
  }

  // Don't advance to/over any failed row's stamp; back off to just below it.
  const next = Number.isFinite(minFailed) ? Math.min(maxConsumed, minFailed - 1) : maxConsumed;
  if (next > since) ctx.store.setKv(K_PULL_SINCE, next);
  return written;
}

// ─── shared semantic-memory READ path (memory_chunks) ────────────────────────

/** One recalled memory chunk from the shared index. `similarity` is 1 - cosine
 *  distance for a search hit (null for a recency listing). */
export interface MemoryChunkHit {
  agentId: string;
  machineId: string;
  ownerLabel: string | null;
  name: string | null;
  content: string;
  similarity: number | null;
}

function mapHit(r: Record<string, unknown>): MemoryChunkHit {
  return {
    agentId: typeof r.agent_id === 'string' ? r.agent_id : '',
    machineId: typeof r.machine_id === 'string' ? r.machine_id : '',
    ownerLabel: typeof r.owner_label === 'string' ? r.owner_label : null,
    name: typeof r.name === 'string' ? r.name : null,
    content: typeof r.content === 'string' ? r.content : '',
    similarity: typeof r.similarity === 'number' ? r.similarity : null
  };
}

/** Cosine top-K recall across the WHOLE workspace's memory (every teammate, every
 *  session, every project) via the match_memory_chunks RPC. The query vector is
 *  embedded LOCALLY by the caller (Ollama) and passed as a pgvector literal.
 *  `agent` scopes to one agent. Best-effort: any error yields []. */
export async function matchMemoryChunks(
  client: SupabaseLike,
  workspaceId: string,
  embedding: number[],
  k: number,
  agent?: string
): Promise<MemoryChunkHit[]> {
  try {
    const { data, error } = await client.rpc('match_memory_chunks', {
      p_workspace: workspaceId,
      p_query: vectorLiteral(embedding),
      p_k: k,
      p_agent: agent ?? null
    });
    if (error || !data) return [];
    return data.map(mapHit);
  } catch {
    return [];
  }
}

/** The most recently updated chunks across the workspace — a no-query "what's
 *  fresh in the team's memory" digest (backs wake-up). Best-effort: []. */
export async function recentMemoryChunks(
  client: SupabaseLike,
  workspaceId: string,
  k: number
): Promise<MemoryChunkHit[]> {
  try {
    const { data, error } = await client
      .from('memory_chunks')
      .select('agent_id, machine_id, owner_label, name, content, updated_at')
      .eq('workspace_id', workspaceId)
      .order('updated_at', { ascending: false })
      .limit(k);
    if (error || !data) return [];
    return data.map(mapHit);
  } catch {
    return [];
  }
}
