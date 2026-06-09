/**
 * SyncManager — Supabase collaborative sync for the harness (orchestrator).
 *
 * GOAL: let a team share one logical hive while every machine stays local-first
 * and fully functional offline. Supabase is a SYNC layer bolted on top of the
 * existing single-committer hive — never a replacement. Local files under
 * `<harnessHome>/hive/` remain the source of truth; Supabase is the shared
 * "upstream" the git repo never had.
 *
 * This file is the orchestrator only. The mechanics live in siblings:
 *   - io.ts     — pure file-tail + dedup-uid helpers.
 *   - push.ts   — pushAppendOnly(): the one-way-up append-only mirror (Phase 1):
 *                   <hive>/log.jsonl → hive_log, cost-ledger.jsonl → cost_ledger,
 *                   SQLite command_history → command_history.
 *   - memory.ts — pushMemory()/pullMemory(): two-way agent-memory sync (Phase 2).
 *   - types.ts  — the shared contract + tunables.
 *
 * Shipping disabled changes nothing: the manager is a complete no-op unless
 * `syncEnabled` AND url/anonKey/workspaceId are all set.
 *
 * Lives in the Electron MAIN process (the renderer CSP blocks supabase.co/wss and
 * the workspace key must stay out of the renderer). Deliberately free of any
 * `electron` import so it can be unit-/smoke-tested as a plain Node module —
 * matching slack.ts. The Supabase client is loaded via dynamic import() so the
 * app still boots (sync just stays inactive) when the dep isn't installed yet.
 */
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  type SyncSettings,
  type SyncStore,
  type SyncStatus,
  type SupabaseLike,
  type HiveBridge,
  type StateSyncCtx,
  type AuthState,
  SYNC_INTERVAL_MS,
  STATE_CATCHUP_MS,
  K_MACHINE,
  K_AUTH_SESSION
} from './types';
import { errMsg } from './io';
import { pushAppendOnly } from './push';
import { pushMemory, pullMemory, matchMemoryChunks, recentMemoryChunks, type MemoryChunkHit } from './memory';
import { pushState, pullStateOnce, subscribeState, listHiveOwners, fetchTeammateAgents, fetchTeammateTasks, type HiveOwner, type TeammateAgent } from './state';
import * as auth from './auth';

export type {
  SyncSettings,
  SyncStore,
  SyncStatus,
  SupabaseLike,
  HiveBridge,
  AuthState,
  StateRows,
  StateSyncCtx,
  AppendPushCtx,
  MemorySyncCtx
} from './types';
export type { MemoryChunkHit } from './memory';

/** Optional hooks the manager calls when a pull lands new mirror memory: ask the
 *  MemoryManager to re-mine, and push a fresh status to the renderer. Mirrors the
 *  emit/callback wiring used by slack/telemetry.
 *
 *  `hive` (Phase 3) is the seam to the hive's shared state (registry/tasks/board):
 *  when present, the manager also push/pull/subscribes that state. index.ts builds
 *  it from the HiveManager; absent it, all shared-state sync is a no-op. */
export interface SyncManagerDeps {
  emit?: (channel: string, payload: unknown) => void;
  requestMine?: () => void;
  hive?: HiveBridge;
  /** Local Ollama embedder (memory/ollama.ts), wired in index.ts. When present,
   *  the memory push also embeds each owned agent's memory.md into the shared
   *  `memory_chunks` index. Absent = text-only memory sync (no embeddings). */
  embed?: (texts: string[]) => Promise<number[][] | null>;
}

export class SyncManager {
  /** The DATA client — built with the `accessToken` callback so REST + realtime
   *  always carry the user's token. Everything except auth ops goes through it. */
  private client: SupabaseLike | null = null;
  /** The AUTH client — a normal client used ONLY for signInWithPassword/setSession/
   *  signOut (the `accessToken` option disables auth, so it can't live on the data
   *  client). Its live session feeds the data client's accessToken callback. */
  private authClient: SupabaseLike | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Phase 3: the 30s shared-state catch-up poll (covers dropped realtime). */
  private stateTimer: ReturnType<typeof setInterval> | null = null;
  /** Phase 3: tears down the realtime channel(s) opened by subscribeState. */
  private stateUnsub: (() => void) | null = null;
  private syncing = false;
  private lastPushAt: number | null = null;
  private lastError: string | null = null;
  private pushed = { log: 0, cost: 0, history: 0 };
  private memory = { pushed: 0, pulled: 0 };
  private state = { pushed: 0, applied: 0 };
  /** Phase 4: in-memory auth state. The session tokens are NOT held here — they
   *  live only in store kv (K_AUTH_SESSION); this is just the tokenless snapshot
   *  surfaced to the renderer + used to gate the loops. */
  private auth: AuthState = { signedIn: false, userId: null, email: null };

  constructor(
    private getSettings: () => SyncSettings,
    private getHome: () => string | null,
    private store: SyncStore,
    private deps: SyncManagerDeps = {}
  ) {}

  // ─── config gates ──────────────────────────────────────────────────────────

  private settings(): SyncSettings {
    const s = this.getSettings();
    return {
      enabled: !!s.enabled,
      url: (s.url ?? '').trim(),
      anonKey: (s.anonKey ?? '').trim(),
      workspaceId: (s.workspaceId ?? '').trim()
    };
  }

  private configured(s = this.settings()): boolean {
    return !!s.url && !!s.anonKey && !!s.workspaceId;
  }

  /** Gate for bringing the CLIENT up — and therefore for signIn + workspace
   *  create/join: only url + anonKey are needed, NOT a workspaceId. A workspace
   *  id doesn't exist yet the first time (you sign in, THEN create/join one), so
   *  requiring it here is the chicken-and-egg that blocks first sign-in. The sync
   *  LOOPS stay gated on canRun() (which additionally needs workspaceId + signedIn). */
  private canConnect(s = this.settings()): boolean {
    return !!s.url && !!s.anonKey;
  }

  /** Phase 4 run gate for the push/pull/state/subscribe loops: configured (url +
   *  anonKey + workspaceId) AND a user is signed in. The client may be up (so
   *  signIn can be called) while this is false — loops then stay idle, preserving
   *  the offline-first posture. */
  private canRun(s = this.settings()): boolean {
    return this.configured(s) && this.auth.signedIn;
  }

  get isRunning(): boolean { return this.client !== null; }

  /** Snapshot for IPC + the 'sync:event' broadcast. */
  status(): SyncStatus {
    const s = this.settings();
    return {
      enabled: s.enabled,
      configured: this.configured(s),
      running: this.isRunning,
      lastPushAt: this.lastPushAt,
      lastError: this.lastError,
      pushed: { ...this.pushed },
      memory: { ...this.memory },
      state: { ...this.state },
      auth: { ...this.auth }
    };
  }

  /** Stable per-machine id, generated once and persisted. Distinguishes rows from
   *  different teammates' machines and seeds the dedup uids. SyncManager owns it. */
  private machineId(): string {
    let id = this.store.getKv<string>(K_MACHINE);
    if (!id) { id = randomUUID(); this.store.setKv(K_MACHINE, id); }
    return id;
  }

  private hiveRoot(): string | null {
    const home = this.getHome();
    return home ? join(home, 'hive') : null;
  }

  // ─── client builder ──────────────────────────────────────────────────────────

  /** Cached supabase-js createClient. Non-literal specifier keeps it an OPTIONAL
   *  dependency — TS/Vite don't hard-resolve it, so the app compiles + boots even
   *  before `npm install` lands the package; sync just stays inactive. */
  private createClientFn: ((url: string, key: string, opts?: unknown) => SupabaseLike) | null = null;
  private async loadCreateClient(): Promise<(url: string, key: string, opts?: unknown) => SupabaseLike> {
    if (this.createClientFn) return this.createClientFn;
    const moduleName = '@supabase/supabase-js';
    const mod = (await import(/* @vite-ignore */ moduleName)) as {
      createClient: (url: string, key: string, opts?: unknown) => SupabaseLike;
    };
    this.createClientFn = mod.createClient;
    return mod.createClient;
  }

  /** realtime-js needs a WebSocket. Electron's MAIN process runs Node 20 (no global
   *  WebSocket), so supabase-js throws on construction unless we hand it `ws` (a
   *  transitive dep of realtime-js). Returns undefined when a native WebSocket
   *  exists (Node 22+/future Electron) or `ws` can't be loaded — then the 30s
   *  catch-up poll still syncs state without realtime. */
  private async wsTransport(): Promise<unknown> {
    if (typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'undefined') return undefined;
    try {
      const wsName = 'ws';
      const wsMod = (await import(/* @vite-ignore */ wsName)) as { default?: unknown };
      return wsMod.default ?? wsMod;
    } catch { return undefined; }
  }

  /** The AUTH client: a normal client used ONLY for signInWithPassword/setSession/
   *  signOut. autoRefreshToken keeps its in-memory session fresh; persistSession is
   *  off (we persist the session ourselves, MAIN-side). */
  private async buildAuthClient(s: SyncSettings): Promise<SupabaseLike> {
    const createClient = await this.loadCreateClient();
    const transport = await this.wsTransport();
    return createClient(s.url, s.anonKey, {
      auth: { persistSession: false, autoRefreshToken: true },
      realtime: { params: { eventsPerSecond: 1 }, ...(transport ? { transport } : {}) }
    });
  }

  /** The DATA client: built with supabase-js's `accessToken` callback, which it
   *  calls for EVERY REST + realtime request and NEVER overrides. This is the
   *  reliable way to authenticate as the user — supabase-js's own session→header
   *  propagation does NOT fire in the Electron main process, so without this, DB
   *  calls go out as `anon` and every membership-scoped RLS policy denies them.
   *  (Providing `accessToken` disables this client's own auth module — fine, all
   *  auth ops use the auth client.) */
  private async buildDataClient(s: SyncSettings): Promise<SupabaseLike> {
    const createClient = await this.loadCreateClient();
    const transport = await this.wsTransport();
    return createClient(s.url, s.anonKey, {
      accessToken: async () => this.currentAccessToken(),
      realtime: { params: { eventsPerSecond: 1 }, ...(transport ? { transport } : {}) }
    });
  }

  /** Resolve the current user access token for the data client's accessToken
   *  callback: prefer the auth client's live (possibly auto-refreshed) session,
   *  else the token we persisted at sign-in. Returns '' when signed out (anon) —
   *  the loops are gated on signedIn, so data calls only fire once a token exists. */
  private async currentAccessToken(): Promise<string> {
    try {
      const got = await this.authClient?.auth.getSession();
      const tok = got?.data?.session?.access_token;
      if (tok) return tok;
    } catch { /* fall back to the persisted token */ }
    return this.store.getKv<{ access_token?: string }>(K_AUTH_SESSION)?.access_token ?? '';
  }

  // ─── lifecycle (mirrors startSlackServer/stopSlackServer) ────────────────────

  /** Bring sync up if enabled + configured. Lazily imports supabase-js so a
   *  missing dependency just leaves sync inactive instead of crashing boot.
   *  Idempotent: replaces any running client. Best-effort — never throws.
   *
   *  Phase 4: the client comes up so `signIn` can be called even before a user is
   *  authenticated; the push/pull/subscribe loops are only ARMED once signed in
   *  (`armLoops`). On start we restore any persisted session first, so a returning
   *  user is authenticated (RLS sees auth.uid()) and the loops arm immediately. */
  async start(): Promise<{ ok: boolean; error?: string }> {
    const s = this.settings();
    if (!s.enabled) return { ok: false, error: 'sync disabled' };
    if (!this.canConnect(s)) return { ok: false, error: 'missing url or anon key' };
    this.stop();
    try {
      // Auth client first (the data client's accessToken callback reads its session).
      this.authClient = await this.buildAuthClient(s);
      this.client = await this.buildDataClient(s);
    } catch (e) {
      this.authClient = null;
      this.client = null;
      const error = `supabase client unavailable: ${errMsg(e)}`;
      this.lastError = error;
      return { ok: false, error };
    }
    this.lastError = null;
    // Phase 4: restore a persisted session on the AUTH client (if any) so a
    // returning user is already authenticated; the data client's accessToken
    // callback then reads the live token. Resolves the tokenless auth snapshot.
    try {
      this.auth = await auth.restoreSession(this.authClient, this.store);
    } catch (e) { this.lastError = errMsg(e); }
    // Only arm the loops when signed in AND configured AND workspaceId set; else
    // the client is up (signIn can be called) but the loops stay idle.
    if (this.canRun(s)) this.armLoops(s);
    return { ok: true };
  }

  /** Arm the push/pull beat + the Phase 3 shared-state realtime channel/catch-up.
   *  Split out of start() so signIn can (re)arm once a session lands. Idempotent:
   *  clears any existing timers/subscription first. Requires `canRun()` true. */
  private armLoops(s = this.settings()): void {
    this.disarmLoops();
    // Phase 3: open the shared-state realtime channel + start the 30s catch-up
    // poll (realtime can drop events). Only when a hive bridge is wired in; on a
    // remote change we bump the applied tally and broadcast a fresh status.
    if (this.deps.hive) {
      const stateCtx = this.stateCtx(s);
      if (stateCtx) {
        try {
          this.stateUnsub = subscribeState(stateCtx, () => {
            this.state.applied += 1;
            this.deps.emit?.('sync:event', this.status());
          });
        } catch (e) { this.lastError = errMsg(e); }
        this.stateTimer = setInterval(() => { void this.catchUpState(); }, STATE_CATCHUP_MS);
      }
    }
    // Kick a first pass now, then beat. void: the loop owns its own errors.
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, SYNC_INTERVAL_MS);
  }

  /** Stop the beats + realtime channel WITHOUT tearing down the client (so signIn
   *  can re-arm). Idempotent, best-effort. */
  private disarmLoops(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.stateTimer) { clearInterval(this.stateTimer); this.stateTimer = null; }
    if (this.stateUnsub) { try { this.stateUnsub(); } catch { /* best-effort */ } this.stateUnsub = null; }
  }

  /** Tear down the client + beats + realtime channel. Idempotent, best-effort.
   *  Leaves the in-memory auth snapshot intact (the persisted session, if any,
   *  outlives a stop/start) — only signOut clears auth. */
  stop(): void {
    this.disarmLoops();
    this.client = null;
    this.authClient = null;
  }

  // ─── Phase 4 auth ────────────────────────────────────────────────────────────

  /** Sign in with email/password. Brings the client up first if needed, delegates
   *  to auth.signIn (which persists the session MAIN-side), then (re)arms the
   *  loops if now runnable and broadcasts a fresh (tokenless) status. */
  async signIn(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.authClient || !this.client) {
      const r = await this.start();
      if (!this.authClient || !this.client) return { ok: false, error: r.error ?? 'sync not started' };
    }
    let res;
    try {
      // Auth ops run on the AUTH client (the data client has no auth module).
      res = await auth.signIn(this.authClient, this.store, email, password);
    } catch (e) {
      const error = errMsg(e);
      this.lastError = error;
      return { ok: false, error };
    }
    if (!res.ok) {
      this.lastError = res.error ?? 'sign-in failed';
      return { ok: false, error: res.error };
    }
    this.auth = { signedIn: true, userId: res.userId ?? null, email: res.email ?? null };
    this.lastError = null;
    // No client rebuild needed: auth.signIn persisted the session to kv and set it
    // on the auth client, so the data client's accessToken callback now returns the
    // user's token on every request — DB calls run as the authenticated user.
    if (this.canRun()) this.armLoops();
    this.deps.emit?.('sync:event', this.status());
    return { ok: true };
  }

  /** Create a new workspace (insert `workspaces` + this user's `workspace_members`
   *  row) and return its id. Requires a signed-in client so RLS sees auth.uid();
   *  delegates the DB rows to auth.ensureWorkspace. The CALLER (IPC) persists the
   *  returned id as `syncWorkspaceId` via writeConfig + restarts — this is the thin
   *  seam that lets the IPC layer reach a real implementation without itself
   *  touching the (private) authenticated client. NEVER returns tokens. */
  async createWorkspace(name: string): Promise<{ ok: boolean; workspaceId?: string; error?: string }> {
    return this.ensureWorkspace({ create: true, name });
  }

  /** Join an existing workspace by id (insert this user's `workspace_members` row).
   *  Same seam/posture as createWorkspace. NEVER returns tokens. */
  async joinWorkspace(id: string): Promise<{ ok: boolean; workspaceId?: string; error?: string }> {
    return this.ensureWorkspace({ create: false, id });
  }

  // ─── teammate-hive read (the unified roster + kanban toggle) ───────────────

  /** List the teammate hives you can switch to in this workspace (everyone but
   *  this machine). Read-only; gated on a signed-in, configured client. */
  async listHiveOwners(): Promise<HiveOwner[]> {
    if (!this.client || !this.auth.signedIn) return [];
    const s = this.settings();
    if (!s.workspaceId) return [];
    try {
      return await listHiveOwners(this.client, s.workspaceId, this.machineId());
    } catch (e) { this.lastError = errMsg(e); return []; }
  }

  /** Fetch a teammate's roster (read-only) by their machine id. */
  async teammateAgents(machineId: string): Promise<TeammateAgent[]> {
    if (!this.client || !this.auth.signedIn) return [];
    const s = this.settings();
    if (!s.workspaceId || !machineId) return [];
    try {
      return await fetchTeammateAgents(this.client, s.workspaceId, machineId);
    } catch (e) { this.lastError = errMsg(e); return []; }
  }

  // ─── shared semantic memory (Ollama embeddings + pgvector) ─────────────────

  /** Is the shared semantic-memory store reachable (signed in + workspace set)?
   *  The MemoryManager gates its search/wake-up on this — the store IS Supabase,
   *  so semantic memory needs sync running, not just Ollama. */
  canRunMemory(): boolean {
    return this.canRun() && this.client !== null;
  }

  /** Cosine top-K recall across the whole workspace's memory. The query vector is
   *  embedded locally (Ollama) by the caller; this just runs the RPC. Read-only,
   *  gated on a signed-in client. Best-effort: []. */
  async matchMemoryChunks(embedding: number[], k: number, agent?: string): Promise<MemoryChunkHit[]> {
    if (!this.canRunMemory() || !this.client) return [];
    const s = this.settings();
    if (!s.workspaceId) return [];
    try {
      return await matchMemoryChunks(this.client, s.workspaceId, embedding, k, agent);
    } catch (e) { this.lastError = errMsg(e); return []; }
  }

  /** Most recently updated chunks across the workspace (backs wake-up). */
  async recentMemoryChunks(k: number): Promise<MemoryChunkHit[]> {
    if (!this.canRunMemory() || !this.client) return [];
    const s = this.settings();
    if (!s.workspaceId) return [];
    try {
      return await recentMemoryChunks(this.client, s.workspaceId, k);
    } catch (e) { this.lastError = errMsg(e); return []; }
  }

  /** Fetch a teammate's kanban (read-only) — same `{ tasks: [...] }` shape as
   *  hiveTasks(), so the renderer reuses its parser. */
  async teammateTasks(machineId: string): Promise<{ tasks: unknown[] }> {
    if (!this.client || !this.auth.signedIn) return { tasks: [] };
    const s = this.settings();
    if (!s.workspaceId || !machineId) return { tasks: [] };
    try {
      return await fetchTeammateTasks(this.client, s.workspaceId, machineId);
    } catch (e) { this.lastError = errMsg(e); return { tasks: [] }; }
  }

  /** Shared body for create/join: gate on a signed-in client, then delegate the
   *  DB rows to auth.ensureWorkspace. Best-effort — never throws. */
  private async ensureWorkspace(
    opts: { create?: boolean; name?: string; id?: string }
  ): Promise<{ ok: boolean; workspaceId?: string; error?: string }> {
    if (!this.client) return { ok: false, error: 'sync not started' };
    if (!this.auth.signedIn) return { ok: false, error: 'sign in first' };
    try {
      return await auth.ensureWorkspace(this.client, this.store, opts);
    } catch (e) {
      const error = errMsg(e);
      this.lastError = error;
      return { ok: false, error };
    }
  }

  /** Sign out: clear the persisted session + in-memory auth, stop the loops, and
   *  broadcast. The client stays up so a new signIn can be issued. */
  async signOut(): Promise<void> {
    if (this.authClient) {
      try { await auth.signOut(this.authClient, this.store); }
      catch (e) { this.lastError = errMsg(e); }
    }
    this.auth = { signedIn: false, userId: null, email: null };
    this.disarmLoops();
    this.deps.emit?.('sync:event', this.status());
  }

  /** Build the shared-state context, or null if not runnable (no client / no
   *  hive bridge / not configured). Centralizes the gate for push + catch-up. */
  private stateCtx(s = this.settings()): StateSyncCtx | null {
    if (!this.client || !this.deps.hive || !this.canRun(s)) return null;
    return {
      client: this.client,
      store: this.store,
      workspaceId: s.workspaceId,
      machineId: this.machineId(),
      hive: this.deps.hive,
      emit: this.deps.emit,
      ownerLabel: this.auth.email ?? undefined
    };
  }

  /** The 30s catch-up body: re-pull shared state to cover dropped realtime
   *  events. Best-effort; on applied rows, refresh status. */
  private async catchUpState(): Promise<void> {
    const ctx = this.stateCtx();
    if (!ctx) return;
    try {
      const applied = await pullStateOnce(ctx);
      if (applied > 0) {
        this.state.applied += applied;
        this.deps.emit?.('sync:event', this.status());
      }
    } catch (e) {
      this.lastError = errMsg(e);
    }
  }

  // ─── sync passes ─────────────────────────────────────────────────────────────

  /** The interval body: push then pull, both best-effort and never throwing. */
  private async tick(): Promise<void> {
    await this.pushNow();
    await this.pullNow();
  }

  /** One full push pass (append-only sinks + agent memory). Serialized via
   *  `syncing` so a slow pass can't overlap the next interval tick. */
  async pushNow(): Promise<void> {
    if (!this.client || this.syncing) return;
    const s = this.settings();
    if (!this.canRun(s)) return;
    this.syncing = true;
    try {
      const machineId = this.machineId();
      const hiveRoot = this.hiveRoot();
      const home = this.getHome();

      if (hiveRoot) {
        try {
          const counts = await pushAppendOnly({
            client: this.client, store: this.store, workspaceId: s.workspaceId, machineId, hiveRoot
          });
          this.pushed.log += counts.log;
          this.pushed.cost += counts.cost;
          this.pushed.history += counts.history;
        } catch (e) { this.lastError = errMsg(e); }
      }

      if (home) {
        try {
          const n = await pushMemory({
            client: this.client, store: this.store, workspaceId: s.workspaceId,
            machineId, home, requestMine: this.deps.requestMine,
            embed: this.deps.embed, ownerLabel: this.auth.email ?? undefined
          });
          this.memory.pushed += n;
        } catch (e) { this.lastError = errMsg(e); }
      }

      // Phase 3: push the hive's shared state (registry/tasks/board) on the same
      // 60s beat, behind the HiveBridge seam. Rides pushNow so it's serialized.
      const stateCtx = this.stateCtx(s);
      if (stateCtx) {
        try {
          this.state.pushed += await pushState(stateCtx);
        } catch (e) { this.lastError = errMsg(e); }
      }

      this.lastPushAt = Date.now();
    } finally {
      this.syncing = false;
    }
  }

  /** One pull pass (agent memory). If anything was written, ask the
   *  MemoryManager to re-mine and broadcast a fresh status. Best-effort. */
  async pullNow(): Promise<void> {
    if (!this.client) return;
    const s = this.settings();
    if (!this.canRun(s)) return;
    const home = this.getHome();
    if (!home) return;
    try {
      const changed = await pullMemory({
        client: this.client, store: this.store, workspaceId: s.workspaceId,
        machineId: this.machineId(), home, requestMine: this.deps.requestMine
      });
      if (changed.length > 0) {
        this.memory.pulled += changed.length;
        this.deps.requestMine?.();
        this.deps.emit?.('sync:event', this.status());
      }
    } catch (e) {
      this.lastError = errMsg(e);
    }
  }
}
