/**
 * Shared types + constants for the SyncManager module (Supabase collaborative
 * sync). Split out of the original single-file `sync.ts` so the orchestrator
 * (index.ts), the append-only push (push.ts), the memory sync (memory.ts), and
 * the pure IO helpers (io.ts) can all share one contract without import cycles.
 *
 * Lives in the Electron MAIN process and is deliberately free of any `electron`
 * import — these are plain Node types so the module can be unit-/smoke-tested
 * (matching slack.ts). See sync/index.ts for the orchestration narrative.
 */
import type { CommandHistoryRow } from '../db';

/** Live sync configuration, read fresh each tick so a Settings change applies on
 *  the next beat (mirrors how the other managers read config live). */
export interface SyncSettings {
  enabled: boolean;
  url: string;
  anonKey: string;
  /** The shared team id stamped on every row. A later phase turns this into a
   *  real auth-scoped `workspaces` row; for now it's a shared opaque string. */
  workspaceId: string;
}

/** The slice of the SQLite PersistStore the SyncManager needs. PersistStore
 *  (src/main/db.ts) already satisfies getKv/setKv/historySince. */
export interface SyncStore {
  getKv<T = unknown>(key: string): T | undefined;
  setKv(key: string, value: unknown): void;
  historySince(afterId: number, limit?: number): CommandHistoryRow[];
}

/**
 * Minimal shape of the @supabase/supabase-js client we rely on — kept local so
 * this module compiles before the (optional) dependency is installed. Defined
 * loosely: the select-chain methods all return the same builder so any subset/
 * order compiles without the package's real generics, and the builder is itself
 * awaitable to a `{ data, error }` result.
 *
 * Phase 3 adds the realtime surface (`channel`/`removeChannel`) used by the
 * shared-state pull. It's still loosely typed so this module compiles without
 * the package: the channel builder's `.on()`/`.subscribe()` both return the same
 * channel so any chain order works.
 */
export interface SupabaseLike {
  from(table: string): SupabaseTable;
  /** Call a Postgres function (PostgREST RPC). Used by the shared semantic-memory
   *  search (`match_memory_chunks`). Awaitable to `{ data, error }`. */
  rpc(fn: string, params?: Record<string, unknown>): SupabaseSelect;
  /** Open (or reuse) a realtime channel by name (Phase 3 shared-state pull). */
  channel(name: string): RealtimeChannelLike;
  /** Tear down a realtime channel opened via `channel()`. */
  removeChannel(ch: RealtimeChannelLike): void;
  /** Phase 4 auth surface (Supabase Auth, email/password). Loosely typed so this
   *  module compiles without the package. Lives in the MAIN process only — the
   *  session (tokens) never crosses IPC. */
  auth: SupabaseAuthLike;
}

/** The slice of `client.auth` Phase 4 uses. Loosely typed (matches the
 *  SupabaseLike posture): only the four calls SyncManager/auth.ts need. */
export interface SupabaseAuthLike {
  signInWithPassword(creds: { email: string; password: string }): Promise<{
    data: {
      user: { id: string; email?: string } | null;
      session: { access_token: string; refresh_token: string } | null;
    } | null;
    error: { message: string } | null;
  }>;
  signOut(): Promise<{ error: { message: string } | null }>;
  setSession(tokens: { access_token: string; refresh_token: string }): Promise<{
    data: { user: { id: string; email?: string } | null } | null;
    error: { message: string } | null;
  }>;
  getUser(): Promise<{
    data: { user: { id: string; email?: string } | null };
    error: { message: string } | null;
  }>;
  /** The current (possibly auto-refreshed) in-memory session. Read by the data
   *  client's `accessToken` callback to get the freshest token. */
  getSession(): Promise<{
    data: { session: { access_token: string } | null } | null;
    error: { message: string } | null;
  }>;
}

/** A Supabase Realtime channel. Loosely typed so it compiles without the
 *  package; `.on()` and `.subscribe()` both return the same channel for
 *  chaining. We only use the `postgres_changes` event family. */
export interface RealtimeChannelLike {
  on(
    type: 'postgres_changes',
    filter: {
      event: '*' | 'INSERT' | 'UPDATE';
      schema: 'public';
      table: string;
      filter?: string;
    },
    cb: (payload: { new?: Record<string, unknown> }) => void
  ): RealtimeChannelLike;
  subscribe(cb?: (status: string) => void): RealtimeChannelLike;
}

/** A query builder over one table. Both the upsert path and the select chain are
 *  exposed; the select chain is awaitable to a result. */
export interface SupabaseTable {
  upsert(
    rows: unknown[],
    opts?: { onConflict?: string; ignoreDuplicates?: boolean }
  ): Promise<{ error: { message: string } | null }>;
  /** Begin an INSERT. Awaitable to `{ error }` (the Notepad write paths don't read
   *  back the inserted rows). Used by publishAgent/addResource. */
  insert(rows: unknown[]): Promise<{ error: { message: string } | null }>;
  select(cols?: string): SupabaseSelect;
  /** Begin a DELETE; the returned builder is filtered with eq() then awaited.
   *  Used to clear an agent's stale memory_chunks before re-inserting. */
  delete(): SupabaseSelect;
}

/** A filtered select. Every filter returns the same builder (loose by design),
 *  and the builder is awaitable to `{ data, error }` (a PromiseLike). */
export interface SupabaseSelect extends PromiseLike<SupabaseResult> {
  eq(column: string, value: unknown): SupabaseSelect;
  neq(column: string, value: unknown): SupabaseSelect;
  gt(column: string, value: unknown): SupabaseSelect;
  order(column: string, opts?: { ascending?: boolean }): SupabaseSelect;
  limit(count: number): SupabaseSelect;
}

/** The awaited result of a select chain. */
export interface SupabaseResult {
  data: Record<string, unknown>[] | null;
  error: { message: string } | null;
}

/** Context for the append-only push pass (push.ts → pushAppendOnly). */
export interface AppendPushCtx {
  client: SupabaseLike;
  store: SyncStore;
  workspaceId: string;
  machineId: string;
  /** Absolute path to `<home>/hive`. */
  hiveRoot: string;
}

/** Context for the agent-memory push/pull passes (memory.ts). */
export interface MemorySyncCtx {
  client: SupabaseLike;
  store: SyncStore;
  workspaceId: string;
  machineId: string;
  /** Absolute path to the harness home (parent of `hive/`). */
  home: string;
  /** Asks the MemoryManager to re-mine after a pull wrote new mirror memories. */
  requestMine?: () => void;
  /** Local Ollama embedder (memory/ollama.ts). When present, pushMemory also
   *  chunks + embeds each OWNED agent's memory.md and upserts the vectors into the
   *  shared `memory_chunks` table (the semantic-memory layer). Absent = text-only
   *  sync, no embeddings (Ollama unreachable / disabled). Returns the document
   *  vectors in input order, or null on any failure (retried next tick). */
  embed?: (texts: string[]) => Promise<number[][] | null>;
  /** Friendly owner label (the signed-in email) stamped on pushed chunk rows for
   *  UI attribution — mirrors the agents/tasks owner_label. */
  ownerLabel?: string;
}

/**
 * The hive's shared state, shaped into DB-column-ready domain rows. This is the
 * DECOUPLING CONTRACT (Phase 3): `sync/state.ts` is PURE TRANSPORT — it knows the
 * DB schema but NOT the hive file shapes. All hive<->DB shape mapping + the LWW
 * merge live behind the `HiveBridge` (implemented in hive.ts, constructed in
 * index.ts). state.ts NEVER imports hive.ts.
 *
 * `readStateRows()` returns DOMAIN fields only — state.ts stamps
 * workspace_id/machine_id/updated_at (where missing) before upserting.
 */
export interface StateRows {
  /** One row per registry agent: { agent_id, name, role, status, cwd, is_god,
   *  archived, last_seen, updated_at }. */
  agents: Record<string, unknown>[];
  /** One row per task: { task_id, payload (whole task as jsonb), status,
   *  assignee, updated_by, updated_at }. */
  tasks: Record<string, unknown>[];
  /** The blackboard, or null when there's no hive yet. */
  board: { body: string; updated_at: number } | null;
}

/**
 * The seam between the transport (state.ts) and the hive's file shapes (hive.ts).
 * index.ts builds this from the HiveManager and passes it into the SyncManager.
 *
 * - `readStateRows()` shapes registry/tasks/board into DB-column-ready domain rows.
 * - `applyStateRows()` merges remote rows LAST-WRITER-WINS + ADDITIVE (never deletes
 *   a local row on pull; remote overwrites a local row ONLY if remote.updated_at is
 *   strictly newer), then atomicWriteJson + commit(). Best-effort; never throws.
 */
export interface HiveBridge {
  readStateRows(): StateRows;
  /** The orchestrator's "team pulse" snippet (<hive>/pulse.md), pushed to
   *  member_notes each beat so teammates see what this user is up to. '' when
   *  empty/missing — the push then derives a short fallback line. */
  pulse(): string;
  applyStateRows(remote: {
    agents?: Record<string, unknown>[];
    tasks?: Record<string, unknown>[];
    board?: { body: string; updated_at: number } | null;
  }): void;
}

/** Context for the shared-state push/pull/subscribe passes (state.ts). */
export interface StateSyncCtx {
  client: SupabaseLike;
  store: SyncStore;
  workspaceId: string;
  machineId: string;
  hive: HiveBridge;
  emit?: (channel: string, payload: unknown) => void;
  /** Friendly owner label stamped onto pushed task rows (the signed-in email) so
   *  the board picker can list teammates by something human. */
  ownerLabel?: string;
}

/**
 * Phase 4 auth state — the ONLY auth info that ever crosses IPC to the renderer.
 * Deliberately tokenless: the renderer learns *that* a user is signed in (and who)
 * but never the session tokens (those live in the MAIN process / store kv).
 */
export interface AuthState {
  signedIn: boolean;
  userId: string | null;
  email: string | null;
}

/** Snapshot of the sync subsystem, surfaced over IPC + emitted on change. */
export interface SyncStatus {
  enabled: boolean;
  configured: boolean; // url + anonKey + workspaceId all present
  running: boolean; // a client is live
  lastPushAt: number | null;
  lastError: string | null;
  pushed: { log: number; cost: number; history: number };
  memory: { pushed: number; pulled: number };
  /** Phase 3 shared state: rows pushed up / remote rows applied locally. */
  state: { pushed: number; applied: number };
  /** Phase 4 auth state (tokenless — see AuthState). */
  auth: AuthState;
}

/** How often to push+pull (ms). Append-only mirror + memory sync — generous;
 *  this is backup/sync, not a hot path. */
export const SYNC_INTERVAL_MS = 60_000;
/** Phase 3 shared-state catch-up poll (ms). Realtime can drop events, so we
 *  re-pull the shared state on this beat in addition to the realtime channel. */
export const STATE_CATCHUP_MS = 30_000;
/** Cap bytes read from a jsonl tail per tick so one giant file can't balloon
 *  memory; the remainder rides the next beat. */
export const MAX_TAIL_BYTES = 4 * 1024 * 1024;
/** Cap history rows per push; the cursor advances by what was actually sent. */
export const MAX_HISTORY_ROWS = 500;

// Cursor / identity keys in the kv store.
export const K_MACHINE = 'sync.machineId';
export const K_OFF_LOG = 'sync.offset.log';
export const K_OFF_COST = 'sync.offset.cost';
export const K_CUR_HISTORY = 'sync.cursor.history';
/** Phase 4: persisted auth session ({access_token, refresh_token}). MAIN-only —
 *  never crosses IPC, never lands in renderer localStorage. */
export const K_AUTH_SESSION = 'sync.auth.session';
