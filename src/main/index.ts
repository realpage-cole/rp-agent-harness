import { app, BrowserWindow, clipboard, dialog, ipcMain, powerSaveBlocker, screen, shell, Notification } from 'electron';
import { spawn } from 'node:child_process';
import { rmSync, existsSync, readFileSync, readdirSync, statSync, cpSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { PtyManager, type SpawnOptions } from './pty';
import {
  readConfig, writeConfig, resetConfig, ensureHarnessHome, ensureClaudePermissionsAccepted,
  modelForRole, ensureDefaultTeam, DEFAULT_TEAM_ID,
  listTeams, getTeam, addTeam, removeTeam, teamHome, teamMissions, setTeamMissions,
  OPS_STANDUP_MISSION, HEARTBEAT_MISSION,
  type HarnessConfig, type ScheduledMission, type TeamConfig
} from './config';
import { TeamRuntime, type TeamRuntimeDeps, type PtyOwner } from './teamRuntime';
import type { TeamSummary, TeamEvent, CloneTeamResult } from '../shared/teams';
import { listDir, readFileText, writeFileText } from './fs';
import {
  getBranch, getStatus, getLog, getBranches, getAheadBehind, isRepo,
  addWorktree, removeWorktree
} from './git';
import { type AgentMeta, type HiveMessage, type HiveTask } from './hive';
// HiveManager, HookServer, CircuitBreaker, TelemetryCollector, ControlRegistry,
// MemoryReflector, ThoughtsService, SyncManager are now constructed inside
// TeamRuntime (one set per team) — index.ts only borrows the default team's
// instances via aliases (see the Teams block below).
import { MemoryManager, type MemorySettings } from './memory';
import { PersistStore } from './db';
import { readAgentUsage, readContextTokens } from './transcript';
import { traceDetails } from './traceDetail';
import { costTotalsFromUsage } from './costTotals';
import { listIssues, listCIRuns } from './github';
import { SlackWebhookServer, SlackReplyServer, postSlackReply } from './slack';
import { WebhookServer, type WebhookInbound, type WebhookTaskStatus } from './webhook';
import { ClosingTimeController, type ClosingTimeEvent, type ClosingTimePhase } from './closingTime';
import {
  inferAgentProvider,
  isClaudeProvider,
  nonInteractiveEnvForProvider,
  providerPreset,
  type AgentProvider
} from '../shared/agentProvider';

const isDev = !!process.env.ELECTRON_RENDERER_URL;
const ptyManager = new PtyManager();
/** Live PTY id → its owning {teamId, agentId}, recorded at spawn (BE-6). The
 *  pty:kill handler only gets the PTY id, so this lets a closed tab archive the
 *  right agent on the RIGHT team's hive. */
const ptyToAgent = new Map<string, PtyOwner>();
/** Live semantic-memory settings (Ollama host/model + master toggle), read fresh
 *  so a Settings change applies on the next embed/search without a restart. The
 *  global MemoryManager owns this; each TeamRuntime keeps its own copy for sync. */
function memorySettings(): MemorySettings {
  const c = readConfig();
  return {
    enabled: c.semanticMemory !== false,
    host: c.ollamaHost ?? 'http://localhost:11434',
    model: c.ollamaEmbedModel ?? 'nomic-embed-text'
  };
}
// Durable harness state (SQLite, main process) — GLOBAL, shared by every team.
// Phase A: window bounds (kv) + net-new command history. Opened in whenReady,
// closed in the teardown blocks.
const persist = new PersistStore();
// Forward ref so the global memory bridge can reach the DEFAULT team's sync
// manager (constructed just below). Closures are lazy → no TDZ at call time.
let defaultRuntime: TeamRuntime;
// Shared semantic memory — GLOBAL (one Ollama embedder for the machine). Reads
// (search/wake-up) bridge into the default team's SyncManager (the local-first
// surface for memory recall); writes ride that team's sync push beat. The store
// bridge is lazy — only invoked at search time, never during construction.
const memory = new MemoryManager(memorySettings, {
  canRun: () => defaultRuntime.syncManager.canRunMemory(),
  match: (embedding, k, agent) => defaultRuntime.syncManager.matchMemoryChunks(embedding, k, agent),
  recent: (k) => defaultRuntime.syncManager.recentMemoryChunks(k)
});

// ─── Teams (multi-team runtimes) ─────────────────────────────────────────────
// Each TeamRuntime bundles one team's full service set (HiveManager + hook server
// + telemetry + breaker + control + reflector + thoughts + sync + the mission
// scheduler + always-on fleet/breaker beats). Phase 1: exactly one — the legacy
// 'default' team, whose home resolves to harnessHome (NO-MOVE; root stays
// <harnessHome>/hive). Phase 2 (cloneTeam) adds more, live in parallel.
// Shared deps every TeamRuntime borrows (the GLOBAL singletons). Reused by the
// default team here and by every cloned team in cloneTeam().
const teamDeps: TeamRuntimeDeps = {
  liveWebContents,
  ptyManager,
  ptyToAgent,
  teardownPty,
  persist,
  memoryEnv: () => memory.env(),
  // Forward routed messages to the closing-time coordinator (BE-8), tagged with
  // the team. No-op until a closing-time protocol is running for that team.
  onRouted: (teamId, msg, targets) => closingControllers.get(teamId)?.onRouted(msg, targets)
};
defaultRuntime = new TeamRuntime(DEFAULT_TEAM_ID, teamDeps);
const teams = new Map<string, TeamRuntime>([[DEFAULT_TEAM_ID, defaultRuntime]]);

// Back-compat aliases for the GLOBAL-surface handlers that legitimately target
// the default team: the Slack/webhook ingestors + the shared-memory/teammate
// sync surface (one workspace UI, default-team scoped), plus bootstrap/reset/
// pulse. Per-team data handlers route through rt(teamId) instead, so they don't
// alias. (BE-7.)
const hive = defaultRuntime.hive;
const syncManager = defaultRuntime.syncManager;

/** Resolve a (possibly absent/unknown) teamId to its runtime — defaulting to the
 *  DEFAULT team for back-compat when omitted or unknown. Every per-team IPC
 *  handler takes a trailing optional `teamId` and routes through this, so a
 *  single-team renderer that passes nothing keeps hitting the default team. */
function rt(teamId?: unknown): TeamRuntime {
  return (typeof teamId === 'string' && teams.get(teamId)) || defaultRuntime;
}

/** Build the renderer-facing summary list for every registered team (teams:list).
 *  Merges the persisted TeamConfig (id/name/createdAt/godId) with the live runtime
 *  state (running/agentCount). A configured team without a runtime yet reads as
 *  not-running / 0 agents. */
function teamSummaries(): TeamSummary[] {
  return listTeams().map((t) => {
    const r = teams.get(t.id);
    return {
      id: t.id,
      name: t.name,
      createdAt: t.createdAt,
      godId: t.godId,
      running: r?.isRunning() ?? false,
      agentCount: r?.agentCount() ?? 0
    };
  });
}

/** Push a teams:* lifecycle event to the renderer. NOT teamId-stamped the way
 *  per-team data events are — it names the team in its payload (§6.1). */
function emitTeamsEvent(ev: TeamEvent): void {
  try { liveWebContents()?.send('teams:event', ev); } catch { /* window gone */ }
}

/** Slug for a team dir name: lowercase, non-alnum → '-', trimmed, capped. */
function slugifyTeamName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'team';
}

/**
 * Clone a team — CONFIGS-ONLY, fresh start (findings-MT-1 §5). Copies the source
 * roster's per-agent config + the API key; resets all live state (fresh memory,
 * empty board/tasks/inbox/outbox, fresh git); registers the team and brings it up
 * LIVE in parallel immediately. The source's accumulated memory/history/cost is
 * deliberately NOT copied. Returns the new team id.
 */
async function cloneTeam(sourceTeamId: string, newName: string): Promise<CloneTeamResult> {
  const home = readConfig().harnessHome;
  if (!home) return { ok: false, error: 'No harness home configured.' };
  const source = teams.get(sourceTeamId) ?? defaultRuntime;
  const srcReg = source.hive.registry();

  // Allocate a stable, unique id (slug + short hex suffix). Guard against both a
  // config collision and a stray on-disk dir.
  let newId = `${slugifyTeamName(newName)}-${randomBytes(3).toString('hex')}`;
  while (getTeam(newId) || existsSync(teamHome(home, newId))) {
    newId = `${slugifyTeamName(newName)}-${randomBytes(3).toString('hex')}`;
  }

  try {
    // Fresh runtime → its HiveManager is scoped to teams/<newId>. ensureHive lays
    // down a clean hive skeleton (board/tasks/pulse/log/registry + git init +
    // COMMANDS/PROTOCOL/gitignore/hook shim).
    const runtime = new TeamRuntime(newId, teamDeps);
    runtime.hive.ensureHive();

    // Carry the source team's tooling manifest + provision script into the clone
    // so its workers get the same per-agent MCP/plugins (hive.ts reads
    // agent-tooling.json at spawn). We do NOT copy `.agenthome`: the enterprise
    // session is per-home and keychain-bound to the original path, so a copied home
    // would carry stale oauthAccount metadata that falsely passes assertLoggedIn.
    // The clone's .agenthome must be logged in once (assertLoggedIn guides the user)
    // and provisioned (bin/provision_agent_tools.py) before its workers run.
    try {
      const srcHive = source.hive.root();
      const dstHive = runtime.hive.root();
      if (srcHive && dstHive) {
        const tooling = join(srcHive, 'agent-tooling.json');
        if (existsSync(tooling)) cpSync(tooling, join(dstHive, 'agent-tooling.json'));
        const provision = join(srcHive, 'bin', 'provision_agent_tools.py');
        if (existsSync(provision)) {
          mkdirSync(join(dstHive, 'bin'), { recursive: true });
          cpSync(provision, join(dstHive, 'bin', 'provision_agent_tools.py'));
        }
      }
    } catch (e) { console.error('[clone] copy tooling:', e); }

    // Copy CONFIGS from the source roster only. Strip the live-state fields
    // (status/lastSeen/archived/sessionId); ensureAgent re-stamps status idle /
    // archived false, seeds a FRESH memory.md + cursor + empty inbox/outbox, and
    // (for the god) sets godId. Accumulated memory is intentionally not carried.
    for (const agent of Object.values(srcReg.agents)) {
      const { status, lastSeen, archived, sessionId, ...meta } = agent;
      runtime.hive.ensureAgent(meta);
    }

    // Register the team: a fresh per-team Supabase workspace id (used only once the
    // user enables sync for this team) + the built-in missions seeded fresh.
    const team: TeamConfig = {
      id: newId,
      name: newName,
      createdAt: Date.now(),
      godId: srcReg.godId ?? 'god',
      syncWorkspaceId: randomBytes(8).toString('hex'),
      missions: [
        { ...OPS_STANDUP_MISSION, lastFiredAt: Date.now() },
        { ...HEARTBEAT_MISSION, lastFiredAt: Date.now() }
      ]
    };
    addTeam(team);

    // Go live in parallel immediately, then tell the renderer to add + switch.
    teams.set(newId, runtime);
    runtime.start();
    emitTeamsEvent({
      kind: 'created',
      teamId: newId,
      summary: {
        id: newId, name: newName, createdAt: team.createdAt, godId: team.godId,
        running: runtime.isRunning(), agentCount: runtime.agentCount()
      }
    });
    return { ok: true, teamId: newId };
  } catch (e) {
    // SF-4 — roll back any partial state so a failed clone never persists as a
    // phantom team (listed in the selector, auto-started next boot). De-register
    // from config + the Map and remove the half-built dir; all best-effort.
    try { teams.delete(newId); } catch { /* noop */ }
    try { removeTeam(newId); } catch { /* noop */ }
    try { rmSync(teamHome(home, newId), { recursive: true, force: true }); } catch { /* noop */ }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

let mainWindow: BrowserWindow | null = null;

/** When true, skip the quit interceptor (user already confirmed). */
let allowQuit = false;

/** Agents spawned with `isolate: true` get a dedicated git worktree; this maps
 *  the agent/pty id → the worktree path so we can tear it down on kill. */
const worktreePaths = new Map<string, string>();
/** id → the original repo cwd the worktree was created from (needed to run
 *  `git worktree remove` from the parent tree, not the worktree itself). */
const worktreeOrigins = new Map<string, string>();

/**
 * Tear down everything tied to a PTY id: archive its hive agent, remove its
 * isolated git worktree, and drop the bookkeeping-map entries. Runs on BOTH an
 * explicit `pty:kill` AND a natural PTY exit (the child finished, crashed, or
 * was killed externally) — without this the agent stays "active" (broadcasts
 * keep mailing a dead inbox), the worktree orphans (plus a dangling `git
 * worktree` registration in the user's real repo), and the maps leak an entry
 * per dead PTY.
 *
 * Idempotent: guarded on map presence and the already-idempotent
 * `hive.setArchived`, so the second call (kill() also makes node-pty fire
 * onExit) is a harmless no-op. Best-effort — every step is wrapped so a teardown
 * error can never crash the caller (an IPC handler or node-pty's onExit).
 */
function teardownPty(id: string): void {
  // 1) Archive the agent on ITS team's hive (BE-6) — retained + flagged; only
  //    live-PTY agents are active.
  const owner = ptyToAgent.get(id);
  if (owner) {
    ptyToAgent.delete(id);
    const r = rt(owner.teamId);
    // Drop breaker state so a dead agent can't leak/zombie a tripped level.
    try { r.breaker.forget(owner.agentId); } catch { /* best-effort */ }
    if (r.hive.enabled()) {
      try { r.hive.setArchived(owner.agentId, true); } catch (e) { console.error('[hive] setArchived failed:', e); }
    }
  }
  // 2) Remove the isolated worktree, if any. Non-blocking; errors are logged.
  const wtPath = worktreePaths.get(id);
  if (wtPath) {
    const origCwd = worktreeOrigins.get(id) ?? wtPath;
    worktreePaths.delete(id);
    worktreeOrigins.delete(id);
    void removeWorktree(origCwd, wtPath)
      .then(r => { if (!r.ok) console.error('[worktree] removeWorktree failed:', r.error); })
      .catch(e => console.error('[worktree] removeWorktree threw:', e));
  }
  syncKeepAwake();
}
// A natural PTY exit must run the same teardown as an explicit kill.
ptyManager.setExitHandler(teardownPty);

/** Keep the system from suspending the harness while agents are running.
 *  Windows Modern Standby suspends desktop apps (and their child `claude`
 *  processes!) shortly after the display sleeps/locks — the whole hive froze
 *  mid-turn until unlock. `prevent-app-suspension` blocks exactly that while
 *  still letting the display turn off and the session lock. Held only while at
 *  least one PTY is alive, so an idle harness doesn't pin a laptop awake. */
let keepAwakeId: number | null = null;
function syncKeepAwake(): void {
  const live = ptyManager.list().length > 0;
  if (live && keepAwakeId === null) {
    keepAwakeId = powerSaveBlocker.start('prevent-app-suspension');
    console.log('[power] keep-awake ON — agents running');
  } else if (!live && keepAwakeId !== null) {
    try { if (powerSaveBlocker.isStarted(keepAwakeId)) powerSaveBlocker.stop(keepAwakeId); } catch { /* noop */ }
    keepAwakeId = null;
    console.log('[power] keep-awake off — no agents');
  }
}

/** The live renderer webContents, or null if the window is gone/destroyed.
 *  Anything that emits to the renderer from a timer/socket/child callback must
 *  route through here — during quit the window can be destroyed while those
 *  callbacks are still in flight, and `.send()` on a destroyed webContents
 *  throws "Object has been destroyed" (the main-process crash dialog). */
function liveWebContents(): Electron.WebContents | null {
  const wc = mainWindow?.webContents;
  return wc && !wc.isDestroyed() ? wc : null;
}

// ─── Slack webhook server (Slack message → the orchestrator's queue) ─────────
/** The running Slack ingestion server, or null when disabled/stopped. */
let slackServer: SlackWebhookServer | null = null;
/** The loopback-only reply endpoint (lets the bundled helper post back to Slack
 *  without ever seeing the bot token). Lifecycle is tied to `slackServer`. */
let slackReplyServer: SlackReplyServer | null = null;
/** Last public tunnel URL handed out — persisted so Settings can re-show the
 *  Request URL after a reopen (Slack reuses it until the server is stopped). */
let lastSlackUrl: string | undefined;

// ─── Slack done-notifier (Slack-origin task → done → one summary reply) ───────
/** Polls the shared kanban (hive/tasks.json) for Slack-origin tasks that reach
 *  'done' and posts ONE summary reply into the originating thread. Lifecycle is
 *  tied to `slackServer`. OUTBOUND-only: it never touches inbound queue/lanes. */
let slackDoneTimer: ReturnType<typeof setInterval> | null = null;
/** Re-entrancy guard so a slow post can't overlap the next tick. */
let slackDonePolling = false;
/** Task ids already notified — exactly-once across re-reads AND restarts. Lazily
 *  loaded from / persisted to `slackDoneNotifiedPath()`. */
let slackDoneNotified: Set<string> | null = null;
/** Ids already 'done' when the observer started — baselined (never notified) so a
 *  summary only ever fires on a live …→done transition, not on pre-existing dones. */
let slackDoneBaseline: Set<string> | null = null;

/** Absolute path to the bundled `md-slack-reply.cjs` helper. Packaged: under
 *  `process.resourcesPath` (electron-builder extraResources). Dev: the repo's
 *  `resources/` dir, resolved from the app path. */
function slackReplyScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'md-slack-reply.cjs')
    : join(app.getAppPath(), 'resources', 'md-slack-reply.cjs');
}

/** Where the helper discovers `{ port, token }` for the loopback endpoint. Kept
 *  under userData (NOT the git repo, NOT embedded into the shared memory). */
function slackReplyConfigPath(): string {
  return join(app.getPath('userData'), 'slack-reply.json');
}

/** Ledger of task ids whose done-summary has already been posted. Ids ONLY — no
 *  secret ever lands here. Under userData (out of the repo, out of the index). */
function slackDoneNotifiedPath(): string {
  return join(app.getPath('userData'), 'slack-done-notified.json');
}

function loadSlackDoneNotified(): Set<string> {
  try {
    const arr = JSON.parse(readFileSync(slackDoneNotifiedPath(), 'utf8'));
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch { /* missing/corrupt → start empty */ }
  return new Set();
}

function persistSlackDoneNotified(set: Set<string>): void {
  try { writeFileSync(slackDoneNotifiedPath(), JSON.stringify([...set])); }
  catch (e) { console.error('[slack] could not persist done-notify ledger:', e); }
}

/** The single in-thread summary for a finished task. Sourced from the task's
 *  result/description (falling back to the title), trimmed Slack-friendly. */
function slackDoneSummary(task: HiveTask): string {
  const body = (task.result ?? task.description ?? '').trim();
  const head = `:white_check_mark: *Done:* ${task.title}`;
  const text = body ? `${head}\n${body}` : head;
  return text.length > 2800 ? `${text.slice(0, 2799)}…` : text;
}

/** One observation pass over the kanban. Posts a summary for any Slack-origin
 *  task that has newly reached 'done'. Best-effort and self-guarding — it must
 *  never throw into the timer, and the bot token never leaves this function. */
async function pollSlackDoneTasks(): Promise<void> {
  if (slackDonePolling) return;
  const botToken = readConfig().slackBotToken;
  if (!botToken) return; // can't post without the token — nothing to do
  let tasks: HiveTask[];
  try {
    const ledger = hive.tasks() as { tasks?: HiveTask[] };
    tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  } catch { return; } // unreadable/missing tasks.json → skip this tick

  const notified = slackDoneNotified ?? (slackDoneNotified = loadSlackDoneNotified());

  // First tick seeds the baseline (ids already done) and posts nothing — so we
  // only ever fire on a transition observed live this session.
  if (slackDoneBaseline === null) {
    slackDoneBaseline = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
    return;
  }
  const baseline = slackDoneBaseline;

  slackDonePolling = true;
  try {
    for (const t of tasks) {
      if (t.status !== 'done') continue;
      if (baseline.has(t.id) || notified.has(t.id)) continue; // already handled
      const slack = t.slack;
      if (!slack || !slack.channel || !slack.thread_ts) continue; // non-Slack-origin → leave alone
      const res = await postSlackReply({
        botToken, channel: slack.channel, thread_ts: slack.thread_ts, text: slackDoneSummary(t)
      });
      if (res.ok) {
        notified.add(t.id);
        persistSlackDoneNotified(notified); // mark-on-success → exactly one delivered reply
      } else {
        // Genuinely undelivered → leave unmarked so a later tick retries. Log
        // the id + error only; never the token or message body.
        console.error('[slack] done-summary post failed for task', t.id, '-', res.error);
      }
    }
  } finally {
    slackDonePolling = false;
  }
}

/** Begin watching the kanban for Slack-origin done-transitions (idempotent). */
function startSlackDoneObserver(): void {
  if (slackDoneTimer) return;
  slackDoneNotified = loadSlackDoneNotified();
  slackDoneBaseline = null; // re-seed on the first tick of this session
  slackDoneTimer = setInterval(() => { void pollSlackDoneTasks(); }, 5000);
}

/** Stop watching the kanban. Safe to call when not running. */
function stopSlackDoneObserver(): void {
  if (slackDoneTimer) { clearInterval(slackDoneTimer); slackDoneTimer = null; }
  slackDoneBaseline = null;
}

/** Build a SlackWebhookServer from the current config and start it, replacing
 *  any running instance, and return the start result (incl. the public tunnel
 *  URL the user pastes into Slack). No-op + error result when the integration is
 *  disabled or the signing secret is unset. */
async function startSlackServer(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const cfg = readConfig();
  if (!cfg.slackEnabled || !cfg.slackSigningSecret) {
    return { ok: false, error: 'slack disabled or missing signing secret' };
  }
  slackServer?.stop();
  slackServer = new SlackWebhookServer({
    port: cfg.slackPort && cfg.slackPort > 0 ? cfg.slackPort : 3847,
    signingSecret: cfg.slackSigningSecret,
    channelId: cfg.slackChannelId,
    // Fires from the HTTP server's event loop (not the IPC thread); route through
    // liveWebContents() so a message arriving during window teardown can't throw.
    // Forwards the full thread metadata so the renderer can ack + reply in-thread.
    onMessage: (m) => {
      try { liveWebContents()?.send('slack:incomingMessage', m); }
      catch { /* window torn down */ }
    }
  });
  const res = await slackServer.start();
  // ok:false means we never bound the port → drop the instance. ok:true with no
  // url just means the tunnel is unavailable; the local handler is still live.
  if (!res.ok) { slackServer = null; return res; }
  if (res.url) lastSlackUrl = res.url;
  // Bring up the loopback reply endpoint (token-gated, never tunneled) and drop
  // the discovery file for the bundled helper. Best-effort: reply path being
  // unavailable must not sink ingestion.
  await startSlackReplyServer();
  // Begin watching the kanban for Slack-origin tasks that reach 'done', to post
  // their one summary reply in-thread. OUTBOUND-only; never touches ingestion.
  startSlackDoneObserver();
  return res;
}

/** Start the loopback reply endpoint and write its `{ port, token }` to userData
 *  so `md-slack-reply.cjs` can reach it. The bot token is read lazily from config
 *  at reply time and never written to this file. */
async function startSlackReplyServer(): Promise<void> {
  slackReplyServer?.stop();
  const token = randomBytes(24).toString('hex');
  slackReplyServer = new SlackReplyServer({
    token,
    getBotToken: () => readConfig().slackBotToken
  });
  const r = await slackReplyServer.start();
  if (!r.ok || r.port === undefined) {
    console.error('[slack] reply endpoint failed to start:', r.error);
    slackReplyServer = null;
    return;
  }
  try {
    writeFileSync(slackReplyConfigPath(), JSON.stringify({ port: r.port, token }), { mode: 0o600 });
  } catch (e) {
    console.error('[slack] could not write reply config:', e);
  }
}

/** Stop and forget the Slack server (+ reply endpoint). Best-effort; safe to call
 *  when not running. The last tunnel URL is retained so Settings keeps showing it. */
function stopSlackServer(): void {
  try { slackServer?.stop(); } catch (e) { console.error('[slack] stop failed:', e); }
  slackServer = null;
  try { slackReplyServer?.stop(); } catch (e) { console.error('[slack] reply stop failed:', e); }
  slackReplyServer = null;
  stopSlackDoneObserver();
  try { if (existsSync(slackReplyConfigPath())) unlinkSync(slackReplyConfigPath()); } catch { /* noop */ }
}

// ─── Generic inbound webhook + status API ────────────────────────────────────
/** The running generic-webhook server, or null when disabled/stopped. A PUBLIC
 *  (tunnel-forwarded) surface — secret-gated, unlike the loopback /reply. */
let webhookServer: WebhookServer | null = null;
/** Last public tunnel URL handed out — persisted so Settings can re-show the
 *  endpoint after a reopen (loca.lt rotates it per restart). */
let lastWebhookUrl: string | undefined;

/** SHA-256 hex of a capability token. The raw token is returned to the caller
 *  exactly once (the POST response) and never persisted; only this digest lands
 *  on the kanban card, so a GET can match without the raw token ever resting. */
function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Turn a verified webhook POST into hive work: create ONE stamped kanban card
 *  (origin + token hash) and route the message to god/the orchestrator's inbox as a
 *  request. Returns the raw capability token + card id to hand back to the caller
 *  (the ONLY echo of the token). The secret never reaches here. Returns null only
 *  if the card — the thing the caller will poll — could not be created. */
function handleWebhookMessage(msg: WebhookInbound): { token: string; taskId: string } | null {
  // 192-bit unguessable token, returned once; only its hash is stored.
  const token = randomBytes(24).toString('hex');
  const taskId = `webhook-${randomBytes(8).toString('hex')}`;
  const full = msg.title ?? msg.message;
  const title = full.length > 80 ? `${full.slice(0, 79)}…` : full;

  // 1) Create the stamped card. This is the critical step — the caller's token is
  //    only useful if a card exists to poll, so a failure here fails the POST.
  try {
    const ledger = hive.tasks() as { tasks?: HiveTask[] };
    const existing = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    const card: HiveTask = {
      id: taskId,
      title,
      description: msg.message,
      status: 'todo',
      dependsOn: [],
      priority: 1,
      createdAt: new Date().toISOString(),
      webhook: { tokenHash: hashWebhookToken(token) }
    };
    hive.writeTasks([...existing, card]);
  } catch (e) {
    console.error('[webhook] could not create task card:', e instanceof Error ? e.message : e);
    return null;
  }

  // 2) Route the work to god/the orchestrator (god inbox request). Body carries ONLY the
  //    user message + the card id (so whoever finishes it updates that card's
  //    status/result for the caller's GET) — never the secret or the raw token.
  //    Best-effort: the card already exists and is pollable even if this hiccups.
  try {
    hive.send({
      to: 'god',
      act: 'request',
      subject: `[webhook] ${title}`,
      body: `${msg.message}\n\n(Inbound via the generic webhook API, tracked as kanban card ${taskId}. When this work is finished, set that card's status to 'done' and fill its 'result' so the caller's status check reflects the outcome.)`,
      requires_reply: false
    }, 'webhook');
  } catch (e) {
    console.error('[webhook] could not route to god:', e instanceof Error ? e.message : e);
  }
  return { token, taskId };
}

/** Resolve a capability token to its task's public status — scoped to the ONE
 *  card whose stored hash matches; never lists or leaks any other task. Returns
 *  null for any non-match (the server answers 404 either way, so a probe can't
 *  tell "unknown" from "malformed"). */
function lookupWebhookStatus(token: string): WebhookTaskStatus | null {
  const wanted = Buffer.from(hashWebhookToken(token));
  let tasks: HiveTask[];
  try {
    const ledger = hive.tasks() as { tasks?: HiveTask[] };
    tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  } catch { return null; }
  for (const t of tasks) {
    const h = t.webhook?.tokenHash;
    if (!h) continue;
    const have = Buffer.from(h);
    // Both are fixed-length sha-256 hex; compare in constant time defensively.
    if (have.length === wanted.length && timingSafeEqual(have, wanted)) {
      return { status: t.status, title: t.title, result: t.result };
    }
  }
  return null;
}

/** Build a WebhookServer from the current config and start it, replacing any
 *  running instance. No-op + error when disabled or the secret is unset. The
 *  public tunnel is opened only here — never on a default; it stays opt-in
 *  (user enables + presses Start in Settings). */
async function startWebhookServer(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const cfg = readConfig();
  if (!cfg.webhookEnabled || !cfg.webhookSecret) {
    return { ok: false, error: 'webhook disabled or missing secret' };
  }
  webhookServer?.stop();
  webhookServer = new WebhookServer({
    port: cfg.webhookPort && cfg.webhookPort > 0 ? cfg.webhookPort : 3849,
    secret: cfg.webhookSecret,
    onMessage: handleWebhookMessage,
    lookupStatus: lookupWebhookStatus
  });
  const res = await webhookServer.start();
  if (!res.ok) { webhookServer = null; return res; }
  if (res.url) lastWebhookUrl = res.url;
  return res;
}

/** Stop and forget the webhook server. Best-effort; safe when not running. The
 *  last tunnel URL is retained so Settings keeps showing it. */
function stopWebhookServer(): void {
  try { webhookServer?.stop(); } catch (e) { console.error('[webhook] stop failed:', e); }
  webhookServer = null;
}

/** The persisted main-window geometry (kv key `window.bounds`). */
interface WindowBounds { x?: number; y?: number; width: number; height: number }

const DEFAULT_WIN = { width: 1440, height: 900 };
const MIN_WIN = { width: 1280, height: 800 };

/** Validate + clamp restored bounds: enforce the minimum size, and drop a
 *  position that no longer lands on any connected display (monitor unplugged) so
 *  the window can't open off-screen. Returns null for unusable input. */
function clampBounds(b: unknown): WindowBounds | null {
  if (!b || typeof b !== 'object') return null;
  const r = b as Partial<WindowBounds>;
  if (typeof r.width !== 'number' || typeof r.height !== 'number') return null;
  const width = Math.max(MIN_WIN.width, Math.round(r.width));
  const height = Math.max(MIN_WIN.height, Math.round(r.height));
  if (typeof r.x !== 'number' || typeof r.y !== 'number') return { width, height };
  const x = Math.round(r.x), y = Math.round(r.y);
  // Keep the position only if the window rect overlaps some display's work area.
  const onScreen = screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    return x < wa.x + wa.width && x + width > wa.x && y < wa.y + wa.height && y + height > wa.y;
  });
  return onScreen ? { x, y, width, height } : { width, height };
}

/** Minimal trailing-edge debounce for the move/resize flood. */
function debounce(fn: () => void, ms: number): () => void {
  let t: NodeJS.Timeout | null = null;
  return () => { if (t) clearTimeout(t); t = setTimeout(() => { t = null; fn(); }, ms); };
}

function createWindow(): void {
  // Restore the last window geometry (kv), falling back to the default size.
  let saved: WindowBounds | null = null;
  try { saved = clampBounds(persist.getKv('window.bounds')); } catch { saved = null; }

  const win = new BrowserWindow({
    width: saved?.width ?? DEFAULT_WIN.width,
    height: saved?.height ?? DEFAULT_WIN.height,
    ...(saved && saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: MIN_WIN.width,
    minHeight: MIN_WIN.height,
    title: 'Hive',
    backgroundColor: '#FFF8E7',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer runs the hive's heartbeat loops (inbox nudge, message
      // flush, telemetry polls). Chromium throttles timers in occluded windows
      // — incl. behind the LOCK SCREEN — which silently stalls the hive while
      // the user is away. Don't.
      backgroundThrottling: false
    }
  });

  mainWindow = win;

  // Persist geometry as the user drags/resizes (debounced) and on close. Skip
  // while maximized/minimized so a restore doesn't save the fullscreen rect.
  const saveBounds = debounce(() => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    try { persist.setKv('window.bounds', win.getBounds()); } catch { /* DB best-effort */ }
  }, 400);
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);
  win.on('close', () => {
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
    try { persist.setKv('window.bounds', win.getBounds()); } catch { /* DB best-effort */ }
  });

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // On macOS, the red-X "close" event by default destroys the window — and on
  // a single-window app, that effectively quits. Intercept it the same way we
  // intercept before-quit so PTY users get the warning.
  win.on('close', (e) => {
    if (allowQuit) return;
    const count = ptyManager.list().length;
    if (count === 0) return;
    e.preventDefault();
    win.focus();
    win.webContents.send('app:closeRequested', { ptyCount: count });
  });

  ptyManager.attachWebContents(win.webContents);

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
}

// ─── IPC: pty lifecycle ─────────────────────────────────────────────────────
ipcMain.handle('pty:spawn', async (_evt, opts: SpawnOptions & { hive?: AgentMeta; isolate?: boolean; resume?: boolean; provider?: AgentProvider; teamId?: string }) => {
  if (!opts || typeof opts.id !== 'string' || typeof opts.cwd !== 'string' || typeof opts.command !== 'string') {
    return { ok: false, error: 'invalid SpawnOptions' };
  }
  // Route this spawn to its team's runtime (BE-6). Omitted/unknown teamId → the
  // default team (back-compat). All hive provisioning + env injection + the
  // ptyToAgent record below use THIS team's HiveManager, so HIVE_ROOT/HIVE_SOCK/
  // OTEL/secrets are all team-correct.
  const team = rt(opts.teamId);
  const teamHive = team.hive;
  // Which CLI is this? Explicit wins; else inferred from the binary
  // (claude/codex/agy). Non-Claude providers skip every Claude-only spawn step
  // below. Persist the resolved provider onto opts (+ hive meta) so the registry
  // record and downstream provider-aware steps agree on one value.
  const provider = inferAgentProvider(opts.command, opts.provider ?? opts.hive?.provider);
  const claudeProvider = isClaudeProvider(provider);
  opts.provider = provider;
  if (opts.hive) opts.hive = { ...opts.hive, provider };
  // Git isolation: when requested and the cwd is a real repo, give this agent
  // its own worktree on an `agent/<id>` branch so it can't clobber other agents'
  // (or the user's) working tree. Best-effort — a failure falls back to the
  // shared cwd rather than blocking the spawn.
  if (opts.isolate === true && await isRepo(opts.cwd)) {
    try {
      const origCwd = opts.cwd;
      const wtRoot = join(readConfig().harnessHome ?? origCwd, 'worktrees');
      // The id is renderer-supplied (validated only as a string). Slugify it so a
      // crafted id can't inject path separators, then assert the resolved path
      // stays under the worktrees root (defends against bare '..' that slugify
      // leaves intact). If it would escape, bail isolation → fall back to cwd.
      const seg = (opts.hive?.id ?? opts.id).replace(/[^A-Za-z0-9._-]/g, '-');
      const wtPath = join(wtRoot, seg);
      if (!resolve(wtPath).startsWith(resolve(wtRoot) + sep)) {
        console.error('[worktree] refusing unsafe worktree path for id:', opts.hive?.id ?? opts.id);
      } else {
        const br = await getBranch(origCwd);
        const baseBranch = 'current' in br && br.current ? br.current : 'main';
        const wt = await addWorktree(origCwd, wtPath, baseBranch);
        if (wt.ok) {
          opts.cwd = wtPath;
          worktreePaths.set(opts.id, wtPath);
          worktreeOrigins.set(opts.id, origCwd);
        } else {
          console.error('[worktree] addWorktree failed:', wt.error);
        }
      }
    } catch (e) {
      console.error('[worktree] isolation failed:', e);
    }
  }
  // If the agent carries hive metadata, provision its workspace and add
  // provider-specific spawn injection. Non-Claude providers get shared AGENT_*
  // env only; Claude Code also gets prompt/settings hook args.
  if (opts.hive && teamHive.enabled()) {
    if (claudeProvider) {
      try { teamHive.assertLoggedIn(!!opts.hive.isGod); }
      catch (e) { return { ok: false, error: (e as Error).message }; }
    }
    try {
      const inj = teamHive.ensureAgent(
        { ...opts.hive, cwd: opts.cwd, provider },
        { semanticMemory: memory.configured(), theme: readConfig().terminalTheme ?? 'light' }
      );
      opts.args = [...(opts.args ?? []), ...inj.args];
      opts.env = { ...(opts.env ?? {}), ...inj.env, ...memory.env() };
    } catch (e) {
      // Hive provisioning is best-effort; never block a spawn on it.
      console.error('[hive] ensureAgent failed:', e);
    }
  }
  // Long-run guardrails + tiering (Lane A #6.4/#6.6). All additive to the args
  // already assembled (incl. the hive injection); an explicit choice always wins.
  // Claude-only — these are Claude Code flags; other CLIs carry their own flags
  // in the command string the renderer already built.
  if (opts.hive && claudeProvider) {
    const cfg = readConfig();
    const args = opts.args ?? [];
    // Model precedence: an explicit per-agent --model (from the renderer) wins;
    // else the user's global defaultModel; else the role-based default tier.
    if (!args.includes('--model')) {
      const m = cfg.defaultModel ?? modelForRole(opts.hive);
      if (m) args.push('--model', m);
    }
    // Coarse runaway cap.
    if (typeof cfg.maxTurns === 'number' && cfg.maxTurns > 0 && !args.includes('--max-turns')) {
      args.push('--max-turns', String(cfg.maxTurns));
    }
    opts.args = args;
  }
  // Idempotent session resume on respawn (#6.6a) — provider-aware: Claude
  // `--resume <sid>`, Antigravity `--conversation <id>`. The recorded session id
  // comes from hook payloads (agy's conversationId flows through the bridge), so
  // a restored worker continues its prior CLI session. Only when requested AND a
  // prior id exists for this agent.
  if (opts.hive && opts.resume === true) {
    const rf = providerPreset(provider).resumeFlag;
    const sid = teamHive.lastSession(opts.hive.id);
    if (rf && sid) {
      const args = opts.args ?? [];
      if (!args.includes(rf)) { args.push(rf, sid); opts.args = args; }
    }
  }
  // Remember which TEAM + agent owns this PTY so closing the tab archives it on
  // the right team's hive (BE-6). A live terminal means active — ensureAgent
  // above already cleared `archived`.
  if (opts.hive?.id) ptyToAgent.set(opts.id, { teamId: team.teamId, agentId: opts.hive.id });
  // Pre-accept Claude Code's bypass-mode warning + folder-trust dialog so the
  // agent (spawned with --permission-mode bypassPermissions) doesn't stall on an
  // interactive prompt it can't answer and exit code 1. Best-effort, never blocks.
  // Claude-only — other CLIs handle their own permission UX.
  if (claudeProvider) {
    try { ensureClaudePermissionsAccepted(opts.cwd); } catch { /* never block spawn */ }
  }
  // Suppress first-run interactive prompts for providers that need it (e.g. Codex
  // directory-trust gate via CODEX_NON_INTERACTIVE). Merges into any env already
  // set on opts.
  const nonInteractiveEnv = nonInteractiveEnvForProvider(provider);
  if (Object.keys(nonInteractiveEnv).length > 0) {
    opts.env = { ...(opts.env ?? {}), ...nonInteractiveEnv };
  }
  const res = ptyManager.spawn(opts);
  syncKeepAwake(); // arm the power-save blocker while ≥1 agent PTY is alive (#18)
  return res;
});
ipcMain.handle('pty:write', (_evt, id: string, data: string) => {
  if (typeof id !== 'string' || typeof data !== 'string') return { ok: false, error: 'invalid args' };
  return ptyManager.write(id, data);
});
ipcMain.handle('pty:resize', (_evt, id: string, cols: number, rows: number) => {
  if (typeof id !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return { ok: false, error: 'invalid args' };
  return ptyManager.resize(id, cols, rows);
});
ipcMain.handle('pty:kill', (_evt, id: string) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  // Kill the process, then run the shared lifecycle teardown (archive the agent,
  // remove its isolated worktree, drop the maps). teardownPty is idempotent, so
  // node-pty firing onExit once the child actually dies is a harmless no-op.
  const res = ptyManager.kill(id);
  teardownPty(id);
  return res;
});
ipcMain.handle('pty:list', () => ptyManager.list());

// ─── IPC: clipboard ─────────────────────────────────────────────────────────
ipcMain.handle('app:copyToClipboard', (_evt, text: unknown) => {
  if (typeof text !== 'string') return { ok: false, error: 'invalid text' };
  try { clipboard.writeText(text); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('app:readClipboard', () => {
  try { return clipboard.readText(); } catch { return ''; }
});
// NOTE: the terminal theme is mirrored into each agent's per-session Claude
// settings at spawn (hive.ensureAgent theme option) — deliberately NOT via
// `claude config set -g theme`, which would also restyle the user's own
// Claude sessions outside the app.

// ─── IPC: folder picker ─────────────────────────────────────────────────────
ipcMain.handle('dialog:chooseFolder', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Pick a folder'
  });
  if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
  return { ok: true as const, path: res.filePaths[0] };
});

// ─── IPC: Terminal.app at a folder ──────────────────────────────────────────
ipcMain.handle('terminal:openAtFolder', async (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string' || cwd.length === 0) return { ok: false, error: 'invalid cwd' };
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const p = spawn('open', ['-a', 'Terminal', cwd]);
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: err.trim() || `open exited ${code}` });
    });
  });
});

// ─── IPC: config ────────────────────────────────────────────────────────────
ipcMain.handle('config:get', (): HarnessConfig => readConfig());
ipcMain.handle('config:update', (_evt, patch: Partial<HarnessConfig>) => writeConfig(patch));
ipcMain.handle('config:ensureHome', (_evt, path: unknown) => {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, error: 'invalid path' };
  return ensureHarnessHome(path);
});

// Change the harnessHome folder. Because every derived path (hive root, sock,
// agent dirs) resolves lazily through getHome(), the only real work is
// optionally MOVING the existing hive and relaunching so every service
// re-binds against the new root. mode: 'move' copies the data (old kept as a
// safety net), 'fresh' just re-points and bootstraps an empty home.
ipcMain.handle('config:changeHome', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { newHome?: unknown; mode?: unknown };
  if (typeof p.newHome !== 'string' || !p.newHome) return { ok: false, error: 'invalid newHome' };
  const mode: 'move' | 'fresh' = p.mode === 'fresh' ? 'fresh' : 'move';
  const newHome = resolve(p.newHome);
  const oldRaw = readConfig().harnessHome;
  const oldHome = oldRaw ? resolve(oldRaw) : null;

  // Guard against same-folder / nested-folder (a move would self-copy forever).
  if (oldHome) {
    if (newHome === oldHome) return { ok: false, error: 'That is already the current home folder.' };
    const a = newHome + sep, b = oldHome + sep;
    if (a.startsWith(b) || b.startsWith(a)) {
      return { ok: false, error: 'Pick a folder that is not inside (or a parent of) the current home.' };
    }
  }

  const ensured = ensureHarnessHome(newHome);
  if (!ensured.ok) return ensured;

  // Tear down everything bound to the OLD root before copying, so nothing writes
  // mid-copy — a live git commit into hive/.git would otherwise be copied as a
  // half-written object and corrupt the moved repo.
  // Stop every team's services (router, hooks, telemetry, sync, reflector,
  // thoughts, mission scheduler, beats), then the GLOBAL servers/probe.
  for (const rt of teams.values()) { try { rt.stop(); } catch (e) { console.error('[changeHome] runtime.stop:', e); } }
  try { stopSlackServer(); } catch (e) { console.error('[changeHome] slack.stop:', e); }
  try { stopWebhookServer(); } catch (e) { console.error('[changeHome] webhook.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[changeHome] memory.stop:', e); }

  if (mode === 'move' && oldHome) {
    try {
      // MF-2 — copy the cloned-team subtree too (NO-MOVE put clones under teams/).
      // Copying only hive/ would strand every clone's data + its copied API key in
      // the old folder while config.teams still points at them. existsSync guards a
      // no-teams install.
      for (const sub of ['hive', 'teams']) {
        const src = join(oldHome, sub);
        if (!existsSync(src)) continue;
        // cpSync copies the whole tree incl. .git and is cross-device safe (unlike
        // renameSync, which throws EXDEV across volumes). We COPY, never delete —
        // the old folder stays as a safety net the user removes manually.
        cpSync(src, join(newHome, sub), { recursive: true, force: true, dereference: false });
      }
    } catch (e) {
      // Copy failed: recover IN PLACE against the unchanged old home (config never
      // repointed) so the user loses nothing, and surface the error — no relaunch.
      bootstrapHiveServices();
      const cfg = readConfig();
      if (cfg.slackEnabled && cfg.slackSigningSecret) void startSlackServer();
      if (cfg.webhookEnabled && cfg.webhookSecret) void startWebhookServer();
      return { ok: false, error: `Could not copy data: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // Repoint config and relaunch so every service re-bootstraps against newHome.
  // (Identical recovery path to resetAll — relaunch is the clean re-bind.)
  allowQuit = true;
  writeConfig({ harnessHome: newHome });
  try { ptyManager.killAll(); } catch (e) { console.error('[changeHome] killAll:', e); }
  app.relaunch();
  app.exit(0);
  return { ok: true as const }; // unreachable (process exits) — typed for the renderer
});

// ─── IPC: filesystem (sandboxed to a root) ──────────────────────────────────
ipcMain.handle('fs:listDir', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return listDir(root, rel);
});
ipcMain.handle('fs:readFile', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return readFileText(root, rel);
});
ipcMain.handle('fs:writeFile', (_evt, root: unknown, rel: unknown, content: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string' || typeof content !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  return writeFileText(root, rel, content);
});

// ─── IPC: git ───────────────────────────────────────────────────────────────
ipcMain.handle('git:isRepo', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return false;
  return isRepo(cwd);
});
ipcMain.handle('git:branch', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getBranch(cwd);
});
ipcMain.handle('git:status', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getStatus(cwd);
});
ipcMain.handle('git:log', (_evt, cwd: unknown, n: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  const count = typeof n === 'number' ? Math.min(500, Math.max(1, n)) : 50;
  return getLog(cwd, count);
});
ipcMain.handle('git:branches', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getBranches(cwd);
});
ipcMain.handle('git:aheadBehind', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getAheadBehind(cwd);
});

// ─── IPC: hive (multi-agent coordination) ───────────────────────────────────
// Every per-team query takes a trailing optional `teamId` (BE-7). Omitted/unknown
// → the default team (back-compat), resolved via rt(). pty:write/resize/kill stay
// PTY-id keyed (no teamId needed).
ipcMain.handle('hive:registry', (_evt, teamId?: unknown) => rt(teamId).hive.registry());
ipcMain.handle('hive:board', (_evt, teamId?: unknown) => rt(teamId).hive.board());
ipcMain.handle('hive:setBoard', (_evt, body: unknown, teamId?: unknown) => {
  if (typeof body !== 'string') return { ok: false, error: 'invalid body' };
  return rt(teamId).hive.setBoard(body);
});
ipcMain.handle('hive:tasks', (_evt, teamId?: unknown) => rt(teamId).hive.tasks());
ipcMain.handle('hive:log', (_evt, n: unknown, teamId?: unknown) => rt(teamId).hive.logTail(typeof n === 'number' ? n : 200));
ipcMain.handle('hive:memory', (_evt, id: unknown, teamId?: unknown) => (typeof id === 'string' ? rt(teamId).hive.memory(id) : ''));
ipcMain.handle('hive:inbox', (_evt, id: unknown, teamId?: unknown) => (typeof id === 'string' ? rt(teamId).hive.inbox(id) : []));
ipcMain.handle('hive:send', (_evt, partial: Partial<HiveMessage>, from: unknown, teamId?: unknown) => {
  const h = rt(teamId).hive;
  if (!h.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  const msg = h.send(partial ?? {}, typeof from === 'string' ? from : 'system');
  return { ok: true, message: msg };
});
ipcMain.handle('hive:writeTasks', (_evt, tasks: unknown, teamId?: unknown) => {
  if (!Array.isArray(tasks)) return { ok: false, error: 'invalid tasks' };
  const h = rt(teamId).hive;
  if (!h.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  h.writeTasks(tasks as HiveTask[]);
  return { ok: true };
});
ipcMain.handle('hive:setArchived', (_evt, id: unknown, archived: unknown, teamId?: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  const h = rt(teamId).hive;
  if (!h.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  h.setArchived(id, archived === true);
  return { ok: true };
});

// ─── IPC: per-agent operator prompt + editable metadata ──────────────────────
// The dashboard shows the full composed system prompt (base, read-only) plus an
// operator-editable addendum (custom) applied on the agent's next respawn.
ipcMain.handle('hive:getAgentPrompt', (_evt, id: unknown, teamId?: unknown) =>
  typeof id === 'string' ? rt(teamId).hive.getAgentPrompt(id) : { base: '', custom: '' });
ipcMain.handle('hive:setAgentPrompt', (_evt, id: unknown, custom: unknown, teamId?: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  return rt(teamId).hive.setAgentPrompt(id, typeof custom === 'string' ? custom : '');
});
ipcMain.handle('hive:updateAgentMeta', (_evt, id: unknown, patch: unknown, teamId?: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  const p = (patch ?? {}) as { name?: unknown; role?: unknown; capabilities?: unknown };
  return rt(teamId).hive.updateAgentMeta(id, {
    name: typeof p.name === 'string' ? p.name : undefined,
    role: typeof p.role === 'string' ? p.role : undefined,
    capabilities: Array.isArray(p.capabilities)
      ? p.capabilities.filter((c): c is string => typeof c === 'string')
      : undefined
  });
});

// ─── IPC: full tool-call traces (transcript-mined payloads) ──────────────────
// The live span buffer carries only metadata; this mines the agent's newest
// Claude Code transcript for the full input/output of each tool call.
ipcMain.handle('hive:traceDetails', (_evt, agentId: unknown, limit: unknown, teamId?: unknown) => {
  if (typeof agentId !== 'string') return [];
  const r = rt(teamId);
  return traceDetails(
    agentId,
    (id) => r.hive.registry().agents[id]?.cwd ?? null,
    (id) => r.telemetry.getAgentSessionId(id),
    typeof limit === 'number' ? limit : 200
  );
});

// ─── IPC: session cost totals (live per-agent usage from the OTel collector) ─
ipcMain.handle('hive:costTotals', (_evt, teamId?: unknown) => costTotalsFromUsage(rt(teamId).telemetry.snapshot().usage));

// ─── IPC: shared semantic memory (Ollama embeddings + Supabase pgvector) ─────
ipcMain.handle('hive:memoryStatus', () => { memory.resetProbe(); return memory.status(); });
ipcMain.handle('hive:searchMemory', (_evt, query: unknown, wing: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, output: '', error: 'empty query' };
  return memory.search(query, { wing: typeof wing === 'string' ? wing : undefined });
});
ipcMain.handle('hive:memoryWakeUp', (_evt, wing: unknown) =>
  memory.wakeUp(typeof wing === 'string' ? wing : undefined));
// "Embed now": kick an immediate sync push so changed memory.md files are
// chunked + embedded into the shared index without waiting for the next beat.
ipcMain.handle('hive:mineNow', (_evt, teamId?: unknown) => { void rt(teamId).syncManager.pushNow(); return { ok: true }; });
// Condense memory.md on demand: an explicit id condenses that one agent (skips
// the size trigger — a "condense now" button); no id runs a full threshold scan.
ipcMain.handle('memory:reflectNow', (_evt, id: unknown, teamId?: unknown) =>
  rt(teamId).reflector.reflectNow(typeof id === 'string' && id ? id : undefined));

// ─── IPC: command history (SQLite — every prompt submitted to an agent) ──────
ipcMain.handle('history:add', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { agentId?: unknown; cwd?: unknown; text?: unknown };
  if (typeof p.agentId !== 'string' || typeof p.text !== 'string') return { ok: false, error: 'invalid args' };
  try {
    persist.addHistory({ agentId: p.agentId, cwd: typeof p.cwd === 'string' ? p.cwd : null, text: p.text });
    return { ok: true };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('history:list', (_evt, agentId: unknown, limit: unknown) =>
  persist.listHistory(
    typeof agentId === 'string' && agentId ? agentId : undefined,
    typeof limit === 'number' ? limit : undefined
  ));
ipcMain.handle('history:search', (_evt, query: unknown, limit: unknown) =>
  persist.searchHistory(typeof query === 'string' ? query : '', typeof limit === 'number' ? limit : undefined));

// ─── IPC: quit confirmation ─────────────────────────────────────────────────
/** Tear the harness down and quit. Shared by the hard "kill all & quit" path
 *  and the closing-time conclusion (after the god confirmed the team saved). */
function teardownAndQuit(): void {
  allowQuit = true;
  // Each teardown step is best-effort: a throw here (e.g. a dying child or a
  // half-torn-down socket) must never abort the quit or pop a crash dialog.
  // Stop every team's services, then the GLOBAL servers/probe/store + PTYs.
  for (const rt of teams.values()) { try { rt.stop(); } catch (e) { console.error('[quit] runtime.stop:', e); } }
  try { stopSlackServer(); } catch (e) { console.error('[quit] slack.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[quit] memory.stop:', e); }
  try { persist.close(); } catch (e) { console.error('[quit] persist.close:', e); }
  try { ptyManager.killAll(); } catch (e) { console.error('[quit] killAll:', e); }
  app.quit();
}
ipcMain.handle('app:confirmClose', () => {
  cancelClosingTime(); // a hard quit overrides a closing time in progress
  teardownAndQuit();
});
ipcMain.handle('app:cancelClose', () => {
  // no-op — modal will close on the renderer side
});

// ─── Closing time across ALL teams (graceful, data-loss-free shutdown, BE-8) ─
// The third quit-dialog button. EVERY running team's god must run the protocol
// (broadcast → workers save + ACK → god concludes with CLOSING-TIME-COMPLETE);
// the app tears down only once every participating team has concluded. One
// ClosingTimeController per team; progress is aggregated into one app-wide event.
const closingControllers = new Map<string, ClosingTimeController>();
const closingStates = new Map<string, ClosingTimeEvent>();
const closingConcluded = new Set<string>();
let closingTargets: string[] = []; // team ids currently running the protocol

/** Lazily build (and cache) a team's controller, bound to its hive + control +
 *  its own live-agent roster. Progress feeds the aggregate; conclusion is gated. */
function controllerFor(teamId: string): ClosingTimeController {
  let c = closingControllers.get(teamId);
  if (!c) {
    const r = rt(teamId);
    c = new ClosingTimeController(
      r.hive,
      // Roster: agents of THIS team with a live PTY right now (ptyToAgent is
      // pruned on every teardown; the registry alone would wait on ghosts).
      () => [...new Set([...ptyToAgent.values()].filter((o) => o.teamId === teamId).map((o) => o.agentId))],
      (ev) => { closingStates.set(teamId, ev); emitAggregateClosing(); },
      () => onTeamConcluded(teamId),
      // #7C.2 steering — reach deeply busy agents at their next hook boundary.
      r.control
    );
    closingControllers.set(teamId, c);
  }
  return c;
}

/** Fold every participating team's state into ONE app-wide closing-time event so
 *  the single quit modal shows aggregate progress: summed acked/total, and the
 *  "weakest" phase (cancelled/timeout dominate; complete only when ALL complete). */
function emitAggregateClosing(): void {
  let acked = 0, total = 0;
  let anyTimeout = false, anyCancelled = false, anyProgress = false;
  let allComplete = closingTargets.length > 0;
  for (const id of closingTargets) {
    const ev = closingStates.get(id);
    if (!ev) { allComplete = false; continue; }
    acked += ev.acked; total += ev.total;
    if (ev.phase === 'timeout') anyTimeout = true;
    if (ev.phase === 'cancelled') anyCancelled = true;
    if (ev.phase === 'started' || ev.phase === 'progress') anyProgress = true;
    if (ev.phase !== 'complete') allComplete = false;
  }
  const phase: ClosingTimePhase =
    anyCancelled ? 'cancelled' : anyTimeout ? 'timeout' : allComplete ? 'complete' : anyProgress ? 'progress' : 'started';
  try { liveWebContents()?.send('app:closingTime', { phase, acked, total } satisfies ClosingTimeEvent); } catch { /* window gone */ }
}

/** A team's god concluded. Tear down only once EVERY participating team has. */
function onTeamConcluded(teamId: string): void {
  closingConcluded.add(teamId);
  if (closingTargets.length > 0 && closingTargets.every((id) => closingConcluded.has(id))) {
    teardownAndQuit();
  }
}

/** Start closing time for every running team that has a live god. Returns an
 *  error (UI falls back to hard quit) only when NO team can run it. */
function startClosingTime(): { ok: boolean; error?: string } {
  if (closingTargets.length > 0) {
    // Re-pressed mid-protocol (e.g. from the timeout view): re-arm each team.
    for (const id of closingTargets) controllerFor(id).start();
    emitAggregateClosing();
    return { ok: true };
  }
  closingStates.clear(); closingConcluded.clear();
  const ran: string[] = []; const errs: string[] = [];
  for (const [teamId, r] of teams) {
    if (!r.isRunning()) continue;
    const res = controllerFor(teamId).start();
    if (res.ok) ran.push(teamId); else errs.push(res.error ?? `${teamId}: cannot run`);
  }
  if (ran.length === 0) {
    closingControllers.clear();
    return { ok: false, error: errs[0] ?? 'No orchestrator is running — closing time needs a god agent to collect the reports.' };
  }
  closingTargets = ran;
  emitAggregateClosing();
  return { ok: true };
}

/** Human cancelled — stand every team's floor back up and reset. */
function cancelClosingTime(): void {
  for (const id of closingTargets) closingControllers.get(id)?.cancel();
  closingTargets = [];
  closingStates.clear();
  closingConcluded.clear();
  closingControllers.clear();
}

ipcMain.handle('app:startClosingTime', () => startClosingTime());
ipcMain.handle('app:cancelClosingTime', () => cancelClosingTime());

// ─── IPC: full reset (wipe data + config, relaunch into onboarding) ──────────
ipcMain.handle('app:resetAll', () => {
  allowQuit = true;
  // Tear everything down first so nothing writes back into the dirs we wipe.
  // Stop every team's services, then the GLOBAL servers/probe/store + PTYs.
  for (const rt of teams.values()) { try { rt.stop(); } catch (e) { console.error('[reset] runtime.stop:', e); } }
  try { stopSlackServer(); } catch (e) { console.error('[reset] slack.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[reset] memory.stop:', e); }
  try { persist.close(); } catch (e) { console.error('[reset] persist.close:', e); }
  try { ptyManager.killAll(); } catch (e) { console.error('[reset] killAll:', e); }
  // Erase the hive (the orchestrator's + every agent's memory, inboxes, tasks,
  // board, git history). Only this harness-created subdir is removed — never the
  // user's whole harnessHome folder, and never the SHARED semantic memory in
  // Supabase (that's team data; a local reset must not nuke teammates' recall).
  // SF-3 — also erase the cloned-team subtree (NO-MOVE clones live under teams/,
  // including their copied API keys); otherwise "reset & start over" leaves secret
  // residue + orphan clone dirs on disk. resetConfig() below clears config.teams.
  const resetHome = readConfig().harnessHome;
  for (const dir of [hive.root(), resetHome ? join(resetHome, 'teams') : null]) {
    if (!dir) continue;
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.error('[reset] rm', dir, e); }
  }
  // Back to first-run defaults, then relaunch clean so all in-memory services
  // re-bootstrap from scratch and the renderer lands on onboarding.
  resetConfig();
  app.relaunch();
  app.exit(0);
});

// ─── IPC: token telemetry (real usage + est. cost from CC transcripts) ───────
// Reconciler/fallback path: per-cwd transcript sum, now priced PER MODEL (cost
// bug #1 fixed in pricing.ts). Kept for back-compat with the existing UsageRow.
ipcMain.handle('hive:agentUsage', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? readAgentUsage(cwd) : null);
// Current context size (tokens) of an agent's LIVE session — the transcript
// path is learned from the agent's hook payloads (SessionStart fires right at
// spawn), so this works even when several agents share one cwd. Null until the
// first hook fires; a known-but-empty transcript reads as 0 so a freshly
// (re)started session zeroes the gauge instead of leaving a stale value up.
ipcMain.handle('hive:agentContext', (_evt, agentId: unknown, teamId?: unknown) => {
  if (typeof agentId !== 'string') return null;
  const tp = rt(teamId).hookServer.transcriptPath(agentId);
  if (!tp) return null;
  return readContextTokens(tp) ?? 0;
});

// ─── IPC: live telemetry (the OTel collector — the locked usage-provider seam) ─
// The fleet grid + span waterfall (#7B) read these; Lane A's breaker (#6)
// consumes getAgentUsage in-process via the provider, not over IPC.
ipcMain.handle('telemetry:usage', (_evt, agentId: unknown, teamId?: unknown) =>
  typeof agentId === 'string' ? rt(teamId).telemetry.getAgentUsage(agentId) : null);
ipcMain.handle('telemetry:spans', (_evt, agentId: unknown, teamId?: unknown) =>
  typeof agentId === 'string' ? rt(teamId).telemetry.getSpans(agentId) : []);
ipcMain.handle('telemetry:snapshot', (_evt, teamId?: unknown) => rt(teamId).telemetry.snapshot());

// ─── IPC: circuit-breaker state (Lane A #6 policy → this lane's avatars/meter) ─
// Lane A's breaker calls this with a BreakerState; we fan it out to the renderer
// on `control:breakerState`, where the avatar adapter gives it precedence over
// hook-derived status (#5C looping/zombie). Defined here so the channel exists
// before Jim's policy lands; he produces, this lane consumes.
ipcMain.handle('control:setBreakerState', (_evt, state: unknown, teamId?: unknown) => {
  rt(teamId).emit('control:breakerState', state);
  return { ok: true };
});

// ─── IPC: operator control over agents (#7C.1–7C.3) ─────────────────────────
// All return the agent's fresh control snapshot so the UI can reflect state. The
// control registry is per-team, so each takes a trailing optional teamId.
ipcMain.handle('control:pause', (_evt, agentId: unknown, on: unknown, teamId?: unknown) => {
  if (typeof agentId !== 'string') return null;
  const c = rt(teamId).control;
  c.pause(agentId, on === true);
  return c.snapshot(agentId);
});
ipcMain.handle('control:resume', (_evt, agentId: unknown, teamId?: unknown) => {
  if (typeof agentId !== 'string') return null;
  const c = rt(teamId).control;
  c.resume(agentId);
  return c.snapshot(agentId);
});
ipcMain.handle('control:gateTool', (_evt, agentId: unknown, tool: unknown, on: unknown, teamId?: unknown) => {
  if (typeof agentId !== 'string' || typeof tool !== 'string') return null;
  const c = rt(teamId).control;
  c.gateTool(agentId, tool, on === true);
  return c.snapshot(agentId);
});
ipcMain.handle('control:steer', (_evt, agentId: unknown, text: unknown, teamId?: unknown) => {
  if (typeof agentId !== 'string' || typeof text !== 'string') return null;
  const c = rt(teamId).control;
  c.steer(agentId, text);
  return c.snapshot(agentId);
});
ipcMain.handle('control:halt', (_evt, agentId: unknown, teamId?: unknown) => {
  if (typeof agentId !== 'string') return null;
  const c = rt(teamId).control;
  c.halt(agentId);
  return c.snapshot(agentId);
});
ipcMain.handle('control:snapshot', (_evt, agentId: unknown, teamId?: unknown) =>
  typeof agentId === 'string' ? rt(teamId).control.snapshot(agentId) : null);

// ─── IPC: scheduled missions (recurring auto-dispatch) ──────────────────────
// Per-team with global fallback: omitted teamId → the default team's list (which
// is the global config.missions, byte-identical to the legacy path).
ipcMain.handle('missions:list', (_evt, teamId?: unknown) =>
  teamMissions(typeof teamId === 'string' ? teamId : DEFAULT_TEAM_ID));
ipcMain.handle('missions:save', (_evt, missions: unknown, teamId?: unknown) => {
  const id = typeof teamId === 'string' ? teamId : DEFAULT_TEAM_ID;
  // lastFiredAt is scheduler-owned. The renderer loads missions once and later
  // sends back a STALE array, so a wholesale write would clobber every
  // lastFiredAt the scheduler has stamped since. Merge by id and keep the newer
  // lastFiredAt (almost always the persisted one) so the UI can never erase it.
  const incoming = (Array.isArray(missions) ? missions : []) as ScheduledMission[];
  const persistedById = new Map(teamMissions(id).map((m) => [m.id, m] as const));
  const merged = incoming.map((m) => {
    const prevLastFired = persistedById.get(m.id)?.lastFiredAt ?? 0;
    const lastFiredAt = Math.max(m.lastFiredAt ?? 0, prevLastFired) || undefined;
    return { ...m, lastFiredAt };
  });
  setTeamMissions(id, merged);
  rt(id).syncMissions(); // re-arm the right team's scheduler
  return { ok: true };
});

// ─── IPC: teams (multi-team — list / clone / lifecycle events) ──────────────
// teams:remove is intentionally OUT of v1 (no removal surface).
ipcMain.handle('teams:list', (): TeamSummary[] => teamSummaries());
ipcMain.handle('teams:clone', async (_evt, sourceTeamId: unknown, newName: unknown): Promise<CloneTeamResult> => {
  if (typeof newName !== 'string' || !newName.trim()) return { ok: false, error: 'A team name is required.' };
  return cloneTeam(typeof sourceTeamId === 'string' ? sourceTeamId : DEFAULT_TEAM_ID, newName.trim());
});

// ─── IPC: full-text search across hive files (board, tasks, memory) ──────────
ipcMain.handle('hive:textSearch', (_evt, query: unknown, teamId?: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, results: [] };
  const root = rt(teamId).hive.root();
  if (!root) return { ok: false, results: [] };
  const q = query.toLowerCase();
  const results: Array<{ source: string; excerpt: string }> = [];
  // Each target file is (path, readable label). agents/<id>/memory.md is expanded below.
  const targets: Array<{ path: string; source: string }> = [
    { path: join(root, 'board.md'), source: 'board.md' },
    { path: join(root, 'tasks.json'), source: 'tasks.json' }
  ];
  const agentsDir = join(root, 'agents');
  if (existsSync(agentsDir)) {
    for (const id of readdirSync(agentsDir)) {
      targets.push({ path: join(agentsDir, id, 'memory.md'), source: `${id}/memory.md` });
    }
  }
  for (const { path, source } of targets) {
    if (!existsSync(path)) continue;
    let hits = 0;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (hits >= 3) break;
      const idx = line.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      // ~40 chars of context on either side of the match.
      const excerpt = line.slice(Math.max(0, idx - 40), idx + q.length + 40).trim();
      results.push({ source, excerpt });
      hits++;
    }
  }
  return { ok: true, results };
});

// ─── IPC: GitHub issue ingestion (gh CLI) ────────────────────────────────────
ipcMain.handle('github:issues', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? listIssues(cwd) : { ok: false, error: 'no cwd' }
);

// ─── IPC: GitHub CI status watcher (gh CLI) ──────────────────────────────────
ipcMain.handle('github:ciRuns', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? listCIRuns(cwd) : { ok: false, error: 'no cwd' }
);

// ─── IPC: desktop notifications toggle ──────────────────────────────────────
ipcMain.handle('app:setNotifications', (_evt, val) => writeConfig({ notifications: val === true }));

// ─── IPC: Slack integration ─────────────────────────────────────────────────
ipcMain.handle('slack:start', () => startSlackServer());
ipcMain.handle('slack:stop', () => { stopSlackServer(); return { ok: true }; });
/** Current connection state + last Request URL — lets Settings hydrate the
 *  "Connected" badge and re-show the persisted tunnel URL on reopen. */
ipcMain.handle('slack:status', () => ({ running: slackServer != null, url: lastSlackUrl }));
/** Absolute path to the bundled reply helper, for the prompt the office worker
 *  runs to post its summary back in-thread. No secret crosses this boundary. */
ipcMain.handle('slack:replyScriptPath', () => slackReplyScriptPath());
/** Renderer's immediate "queued" ack into the triggering Slack thread. The bot
 *  token stays in main — only channel/thread/text cross IPC. */
ipcMain.handle('slack:reply', (_evt, arg: unknown) => {
  const p = (arg ?? {}) as { channel?: unknown; thread_ts?: unknown; text?: unknown };
  const botToken = readConfig().slackBotToken;
  if (!botToken) return { ok: false, error: 'no bot token' };
  if (typeof p.channel !== 'string' || typeof p.thread_ts !== 'string' || typeof p.text !== 'string') {
    return { ok: false, error: 'channel, thread_ts, text required' };
  }
  return postSlackReply({ botToken, channel: p.channel, thread_ts: p.thread_ts, text: p.text });
});
ipcMain.handle('slack:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as {
    signingSecret?: unknown; botToken?: unknown; channelId?: unknown; port?: unknown; enabled?: unknown;
  };
  const next: Partial<HarnessConfig> = {};
  // Trim string fields; an emptied field clears back to undefined.
  if (typeof p.signingSecret === 'string') next.slackSigningSecret = p.signingSecret.trim() || undefined;
  if (typeof p.botToken === 'string') next.slackBotToken = p.botToken.trim() || undefined;
  if (typeof p.channelId === 'string') next.slackChannelId = p.channelId.trim() || undefined;
  if (typeof p.port === 'number' && Number.isFinite(p.port)) next.slackPort = p.port;
  if (typeof p.enabled === 'boolean') next.slackEnabled = p.enabled;
  writeConfig(next);
  // Reconcile the running server: disabling (or clearing the secret) stops it. We
  // deliberately do NOT auto-(re)start here — the user presses Start in Settings
  // to fetch the fresh (ephemeral) tunnel URL.
  const cfg = readConfig();
  if (!cfg.slackEnabled || !cfg.slackSigningSecret) stopSlackServer();
  return { ok: true };
});

/** Adopt a workspace id as `syncWorkspaceId` and reconcile the running client:
 *  (re)start when enabled + fully configured (which now includes the workspace
 *  id and a signed-in user, gated inside the manager), else stop. Returns the
 *  adopted id; NEVER tokens. Shared by sync:createWorkspace/joinWorkspace after
 *  the SyncManager has written the workspaces/members DB rows. */
async function adoptWorkspaceId(id: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  writeConfig({ syncWorkspaceId: id });
  const cfg = readConfig();
  const fullyConfigured = !!cfg.supabaseUrl && !!cfg.supabaseAnonKey && !!cfg.syncWorkspaceId;
  if (cfg.syncEnabled && fullyConfigured) {
    const r = await syncManager.start();
    return { ...r, id };
  }
  syncManager.stop();
  return { ok: true, id };
}

// ─── IPC: Supabase collaborative sync ───────────────────────────────────────
/** Bring sync up (lazy-imports the supabase client; gated on enabled+configured). */
ipcMain.handle('sync:start', () => syncManager.start());
ipcMain.handle('sync:stop', () => { syncManager.stop(); return { ok: true }; });
/** Snapshot for the Settings badge (enabled/configured/running + counters). */
ipcMain.handle('sync:status', () => syncManager.status());
/** Persist sync settings, then reconcile the running client: start when fully
 *  configured + enabled, otherwise stop. Only the provided keys are written
 *  (writeConfig spreads, so undefined keys are never sent). */
ipcMain.handle('sync:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as {
    syncEnabled?: unknown; supabaseUrl?: unknown; supabaseAnonKey?: unknown; syncWorkspaceId?: unknown;
  };
  const next: Partial<HarnessConfig> = {};
  if (typeof p.syncEnabled === 'boolean') next.syncEnabled = p.syncEnabled;
  // Trim string fields; an emptied field clears back to undefined.
  if (typeof p.supabaseUrl === 'string') next.supabaseUrl = p.supabaseUrl.trim() || undefined;
  if (typeof p.supabaseAnonKey === 'string') next.supabaseAnonKey = p.supabaseAnonKey.trim() || undefined;
  if (typeof p.syncWorkspaceId === 'string') next.syncWorkspaceId = p.syncWorkspaceId.trim() || undefined;
  writeConfig(next);
  const cfg = readConfig();
  const fullyConfigured = !!cfg.supabaseUrl && !!cfg.supabaseAnonKey && !!cfg.syncWorkspaceId;
  if (cfg.syncEnabled && fullyConfigured) return syncManager.start();
  syncManager.stop();
  return { ok: true, running: false };
});

// ─── IPC: Supabase Auth (Phase 4) ───────────────────────────────────────────
// Sign-in/out delegate to the SyncManager, which owns the in-memory auth state
// and persists the session (tokens) MAIN-side in the store kv. CRITICAL: these
// handlers NEVER return tokens — only {ok,error?}. The renderer learns auth
// STATE solely via the tokenless `auth` field on the sync status snapshot
// (sync:status / the sync:event broadcast).
/** Sign in with email/password. Brings the client up if needed, persists the
 *  session MAIN-side, (re)arms the loops if now runnable, and broadcasts a fresh
 *  status. Returns ONLY {ok,error?}. */
ipcMain.handle('sync:signIn', (_evt, email: unknown, password: unknown) => {
  if (typeof email !== 'string' || typeof password !== 'string') {
    return { ok: false, error: 'email and password are required' };
  }
  return syncManager.signIn(email, password);
});
/** Sign out: clears the persisted session + in-memory auth and stops the loops
 *  (the client stays up so a new signIn can be issued). */
ipcMain.handle('sync:signOut', async () => { await syncManager.signOut(); return { ok: true }; });
/** Create a new workspace (name) and adopt its id as `syncWorkspaceId`, then
 *  (re)start so the loops arm against it. The DB rows (INSERT workspaces + this
 *  user's workspace_members row) are written by SyncManager.createWorkspace via
 *  auth.ensureWorkspace, using the signed-in client that lives inside the manager
 *  so RLS sees auth.uid(); this handler only persists the returned id + restarts.
 *  NEVER returns tokens — only {ok, id?, error?}. */
ipcMain.handle('sync:createWorkspace', async (_evt, opts: unknown) => {
  const o = (opts ?? {}) as { name?: unknown };
  if (typeof o.name !== 'string' || !o.name.trim()) {
    return { ok: false, error: 'workspace name is required' };
  }
  const r = await syncManager.createWorkspace(o.name.trim());
  if (!r.ok || !r.workspaceId) return { ok: false, error: r.error ?? 'could not create workspace' };
  return adoptWorkspaceId(r.workspaceId);
});
/** Join an existing workspace by id: SyncManager.joinWorkspace writes this user's
 *  `workspace_members` row (via auth.ensureWorkspace, signed-in client → RLS sees
 *  auth.uid()), then we adopt the id as `syncWorkspaceId` and (re)start so the
 *  loops scope to it. NEVER returns tokens — only {ok, id?, error?}. */
ipcMain.handle('sync:joinWorkspace', async (_evt, opts: unknown) => {
  const o = (opts ?? {}) as { id?: unknown };
  if (typeof o.id !== 'string' || !o.id.trim()) {
    return { ok: false, error: 'workspace id is required' };
  }
  const r = await syncManager.joinWorkspace(o.id.trim());
  if (!r.ok || !r.workspaceId) return { ok: false, error: r.error ?? 'could not join workspace' };
  return adoptWorkspaceId(r.workspaceId);
});
/** List the teammate hives you can switch to (read-only roster + kanban picker). */
ipcMain.handle('sync:listHiveOwners', () => syncManager.listHiveOwners());
/** Fetch a teammate's roster (read-only) by their machine id. */
ipcMain.handle('sync:teammateAgents', (_evt, machineId: unknown) =>
  typeof machineId === 'string' ? syncManager.teammateAgents(machineId) : Promise.resolve([]));
/** Fetch a teammate's kanban (read-only) by their machine id; same shape as hive:tasks. */
ipcMain.handle('sync:teammateTasks', (_evt, machineId: unknown) =>
  typeof machineId === 'string' ? syncManager.teammateTasks(machineId) : Promise.resolve({ tasks: [] }));

// ─── IPC: Notepad shared surface (team pulse / agent library / pinned links) ─
// TEAM PULSE — read every teammate's pulse; write THIS user's via the hive
// (pulse.md), pushed to member_notes on the next beat. All read paths are
// best-effort ([] / no-op when sync is off or signed out).
ipcMain.handle('notepad:memberNotes', () => syncManager.listMemberNotes());
ipcMain.handle('notepad:setMyPulse', (_evt, body: unknown) =>
  hive.setPulse(typeof body === 'string' ? body : ''));
// AGENT LIBRARY — the shared catalog of publishable agent definitions.
ipcMain.handle('notepad:listSharedAgents', () => syncManager.listSharedAgents());
ipcMain.handle('notepad:publishAgent', (_evt, input: unknown, why: unknown) => {
  const i = (input ?? {}) as {
    name?: unknown; role?: unknown; capabilities?: unknown;
    model?: unknown; accent?: unknown; customPrompt?: unknown;
  };
  if (typeof i.name !== 'string' || !i.name.trim()) return { ok: false, error: 'name required' };
  return syncManager.publishAgent(
    {
      name: i.name,
      role: typeof i.role === 'string' ? i.role : undefined,
      capabilities: Array.isArray(i.capabilities)
        ? i.capabilities.filter((c): c is string => typeof c === 'string')
        : undefined,
      model: typeof i.model === 'string' ? i.model : undefined,
      accent: typeof i.accent === 'string' ? i.accent : undefined,
      customPrompt: typeof i.customPrompt === 'string' ? i.customPrompt : undefined
    },
    typeof why === 'string' ? why : ''
  );
});
ipcMain.handle('notepad:unpublishAgent', (_evt, id: unknown) =>
  typeof id === 'string' ? syncManager.unpublishAgent(id) : Promise.resolve({ ok: false }));
// PINNED LINKS — the shared resources list.
ipcMain.handle('notepad:listResources', () => syncManager.listResources());
ipcMain.handle('notepad:addResource', (_evt, input: unknown) => {
  const i = (input ?? {}) as { label?: unknown; url?: unknown; note?: unknown };
  if (typeof i.label !== 'string' || typeof i.url !== 'string') return { ok: false };
  return syncManager.addResource({
    label: i.label,
    url: i.url,
    note: typeof i.note === 'string' ? i.note : undefined
  });
});
ipcMain.handle('notepad:removeResource', (_evt, id: unknown) =>
  typeof id === 'string' ? syncManager.removeResource(id) : Promise.resolve({ ok: false }));
// NOTEPAD BOARDS — the agent board (authored by the THOUGHTS service) + the human
// board (the add box). Reads return [] when sync is off/signed out; the add path
// FORCES authorKind 'human' so a renderer can never spoof an agent entry.
ipcMain.handle('notepad:listBoardEntries', (_evt, board: unknown) =>
  syncManager.listBoardEntries(board === 'agent' ? 'agent' : 'human'));
ipcMain.handle('notepad:addBoardEntry', (_evt, input: unknown) => {
  const i = (input ?? {}) as { board?: unknown; body?: unknown };
  if (typeof i.body !== 'string' || !i.body.trim()) return { ok: false, error: 'body required' };
  return syncManager.appendBoardEntry({
    board: i.board === 'agent' ? 'agent' : 'human',
    body: i.body,
    authorKind: 'human'
  });
});
ipcMain.handle('notepad:removeBoardEntry', (_evt, id: unknown) =>
  typeof id === 'string' ? syncManager.removeBoardEntry(id) : Promise.resolve({ ok: false }));

// ─── IPC: Generic webhook + status API ──────────────────────────────────────
ipcMain.handle('webhook:start', () => startWebhookServer());
ipcMain.handle('webhook:stop', () => { stopWebhookServer(); return { ok: true }; });
/** Current state + last public endpoint URL, for the Settings badge/URL field. */
ipcMain.handle('webhook:status', () => ({ running: webhookServer != null, url: lastWebhookUrl }));
/** Mint a strong (256-bit) secret, persist it, and return it so Settings can show
 *  it for the user to copy into their client. The previous secret is replaced. */
ipcMain.handle('webhook:generateSecret', () => {
  const secret = randomBytes(32).toString('hex');
  writeConfig({ webhookSecret: secret });
  return { ok: true, secret };
});
ipcMain.handle('webhook:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as { secret?: unknown; port?: unknown; enabled?: unknown };
  const next: Partial<HarnessConfig> = {};
  if (typeof p.secret === 'string') next.webhookSecret = p.secret.trim() || undefined;
  if (typeof p.port === 'number' && Number.isFinite(p.port)) next.webhookPort = p.port;
  if (typeof p.enabled === 'boolean') next.webhookEnabled = p.enabled;
  writeConfig(next);
  // Disabling (or clearing the secret) stops the public surface immediately. As
  // with Slack we do NOT auto-(re)start — the user presses Start to open the
  // tunnel and fetch the fresh endpoint URL.
  const cfg = readConfig();
  if (!cfg.webhookEnabled || !cfg.webhookSecret) stopWebhookServer();
  return { ok: true };
});

/** Start every team's background services against the current harnessHome.
 *  Called on boot, and again to recover in place if a folder-change copy fails
 *  (config:changeHome tears these down before copying). Seeds the legacy hive as
 *  the 'default' team (NO-MOVE — nothing on disk moves), warms the GLOBAL Ollama
 *  memory probe once, then starts each TeamRuntime (Phase 1: just the default
 *  team; each runtime no-ops without a home). */
function bootstrapHiveServices(): void {
  if (!readConfig().harnessHome) return;
  // Register the legacy hive under the 'default' team (idempotent). godId is read
  // from the live registry so the default team records the existing god.
  try { ensureDefaultTeam(hive.registry().godId ?? 'god'); } catch (e) { console.error('[boot] ensureDefaultTeam:', e); }
  // MF-1 — rehydrate persisted clones (NO-MOVE leaves their dirs on disk, but the
  // teams Map only seeds 'default'). Without this, after a restart rt(cloneId)
  // falls through to defaultRuntime and the clone's god silently drives the
  // DEFAULT hive (cross-team corruption). Instantiate a runtime for every
  // registered non-default team before the start loop.
  for (const t of listTeams()) {
    if (!teams.has(t.id)) teams.set(t.id, new TeamRuntime(t.id, teamDeps));
  }
  memory.start(); // GLOBAL Ollama reachability probe (one per app; embedding rides each team's sync beat)
  for (const rt of teams.values()) rt.start();
}

/** One-time userData migration after the munder-difflin → hive rename. The app
 *  name (and thus app.getPath('userData')) derives from package.json "name" (no
 *  app.setName), so renaming moves the userData dir and would orphan config.json
 *  (harnessHome pointer + team registrations). If the new dir has no config.json
 *  but the old `munder-difflin` userData does, copy the old tree over. Idempotent:
 *  once config.json exists in the new dir, this is a no-op. */
function migrateUserData(): void {
  try {
    const dst = app.getPath('userData');
    if (existsSync(join(dst, 'config.json'))) return; // already migrated, or a fresh install
    const old = join(app.getPath('appData'), 'munder-difflin');
    if (existsSync(join(old, 'config.json'))) {
      cpSync(old, dst, { recursive: true });
      console.log('[boot] migrated userData munder-difflin →', dst);
    }
  } catch (e) { console.error('[boot] userData migration:', e); }
}

app.whenReady().then(() => {
  // FIRST: carry config/db across the munder-difflin → hive rename before anything
  // reads userData (slackReplyConfigPath, persist.open, readConfig all live there).
  migrateUserData();
  // Hand every spawned agent the path to the Slack reply discovery file via the
  // inherited env (pty merges process.env). The path is stable whether or not the
  // server is running; the FILE only exists while it is, so the helper degrades
  // to "endpoint not running" cleanly. NO secret is in the env — only the path.
  process.env.MD_SLACK_REPLY_CONFIG = slackReplyConfigPath();
  // Open the durable store first — createWindow() reads the saved window bounds.
  // Guarded: a DB failure (e.g. a bad native build) must degrade to defaults,
  // never block app startup.
  try { persist.open(); } catch (e) { console.error('[db] open failed:', e); }
  // Bootstrap every team's services (router, hooks, telemetry, sync, beats). Each
  // TeamRuntime.start() self-gates collaborative sync on syncEnabled + a complete
  // config (lazy supabase import), so no separate sync auto-start is needed here.
  bootstrapHiveServices();
  createWindow();
  // Auto-start the Slack webhook server when configured. Best-effort: a tunnel
  // failure (offline) is logged, not fatal. The tunnel URL is ephemeral and
  // changes per restart, so the user re-pastes it via Settings → Start.
  const slackCfg = readConfig();
  if (slackCfg.slackEnabled && slackCfg.slackSigningSecret) {
    void startSlackServer().then((r) => {
      if (!r.ok) console.error('[slack] auto-start failed:', r.error);
      else console.log('[slack] webhook listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
    });
  }
  // Auto-start the generic webhook only when the user has explicitly enabled it
  // AND a secret exists — never a default-on public surface. Opt-in, like Slack.
  if (slackCfg.webhookEnabled && slackCfg.webhookSecret) {
    void startWebhookServer().then((r) => {
      if (!r.ok) console.error('[webhook] auto-start failed:', r.error);
      else console.log('[webhook] listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
    });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// before-quit covers Cmd-Q / dock-quit; the per-window close handler covers
// the red close button. Both routes hit the same warning UX.
app.on('before-quit', (e) => {
  if (allowQuit) return;
  const count = ptyManager.list().length;
  if (count === 0) return;
  e.preventDefault();
  if (mainWindow) {
    mainWindow.focus();
    mainWindow.webContents.send('app:closeRequested', { ptyCount: count });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    ptyManager.killAll();
    app.quit();
  }
});
