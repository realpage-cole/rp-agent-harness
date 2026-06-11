import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { autoModeFlagForProvider, inferAgentProvider, type AgentProvider } from '../shared/agentProvider';

/** A recurring auto-dispatched mission fired on an interval by the scheduler. */
export interface ScheduledMission {
  id: string;
  label: string;
  intervalMs: number;
  to: string;
  body: string;
  enabled: boolean;
  /** When true, the scheduler also sends `/compact` to every live terminal when
   *  this mission fires — keeping each agent's context lean on a cadence. */
  autoCompact?: boolean;
  lastFiredAt?: number;
  /** Mission flavor. Absent ⇒ 'dispatch' (the classic interval-dispatch mission,
   *  e.g. the ops standup). 'heartbeat' (Lane A #1) is a context-aware beat: it
   *  observes live floor state, re-engages a quiet god, and ticks the circuit
   *  breaker — armed with an adaptive cadence, not a fixed setInterval. */
  kind?: 'dispatch' | 'heartbeat';
  /** Heartbeat only: a floor is "quiet" when no tracked signal (log.jsonl mtime,
   *  inbox/outbox mtimes, any PTY output) has moved in this many ms. Default
   *  ~5 min. NOT derived from registry.status (which never transitions in main). */
  quietThresholdMs?: number;
}

/** The built-in hourly ops standup: god reviews who's doing what + whether tasks
 *  are on track and agents are running, and every terminal's context is compacted.
 *  Shipped enabled by default; users can toggle it off in the Command Center. */
export const OPS_STANDUP_MISSION: ScheduledMission = {
  id: 'ops-standup',
  label: 'Hourly ops standup',
  intervalMs: 3_600_000,
  to: 'god',
  body:
    'Hourly ops standup. Review every agent: who is doing what, and confirm each ' +
    'is still running (not stalled or idle-stale). Check the task board — are ' +
    'in-flight tasks on track, and is anything blocked or unowned? Flag stale ' +
    'agents and at-risk tasks, and keep the board accurate. (As part of this ' +
    "standup each working agent is asked to summarise its current task and the " +
    'next step, then compact and resume from the same point — so terminal ' +
    'contexts stay bounded without losing work. The compaction is queued and ' +
    'runs when an agent is idle, so it never interrupts work mid-step.)',
  enabled: true,
  autoCompact: true
};

/** The built-in heartbeat (Lane A #1). A context-aware beat that, each tick,
 *  observes live floor state and — only when the floor has gone quiet — drops a
 *  digest into god's inbox and (if god's PTY is genuinely idle) nudges it to
 *  re-engage anyone stalled. The same beat ticks the circuit breaker.
 *
 *  Shipped DISABLED by default (opt-in): unlike the standup, which only sends a
 *  hive message, the heartbeat types into god's PTY, so the user turns it on
 *  explicitly in the Command Center once they want active re-engagement.
 *  `intervalMs` is the normal-cadence base; the scheduler derives a tighter beat
 *  when an agent looks stuck and a slower one right after a re-engage. */
export const HEARTBEAT_MISSION: ScheduledMission = {
  id: 'heartbeat',
  label: 'Idle heartbeat',
  intervalMs: 120_000,
  to: 'god',
  body:
    'Idle heartbeat: the team has gone quiet. Review the digest in your inbox, ' +
    're-engage anyone stalled or blocked, and keep the board accurate — or rest ' +
    'if the work is genuinely done.',
  enabled: false,
  kind: 'heartbeat',
  quietThresholdMs: 300_000
};

/** Circuit-breaker thresholds (Lane A #6.6b). The breaker runs inside the
 *  heartbeat beat, so it only ticks when the heartbeat is enabled. Trip
 *  conditions are behavioral by default; `costCapUsd` is the only $-based one and
 *  is unset by default (a hardcoded dollar default would be arbitrary). Defaults
 *  are deliberately conservative and steer-first — `hardStop` is OFF unless the
 *  user opts in, so the breaker never auto-kills a healthy long-runner. */
export interface CircuitBreakerConfig {
  /** Master switch for breaker evaluation within the beat. Default true. */
  enabled?: boolean;
  /** Allow the top of the ladder (kill PTY + archive). Default false = the
   *  breaker may steer/constrain but never hard-stops until the user opts in. */
  hardStop?: boolean;
  /** Consecutive identical tool calls (same name+input) before tripping. */
  repeatedToolLimit?: number;
  /** Consecutive api_error / retry events before tripping. */
  errorStormLimit?: number;
  /** Output-token velocity (tokens/min, diffed across beats) before tripping. */
  tokenVelocityPerMin?: number;
}

/** The canonical id of the original/legacy team. NO-MOVE migration: the default
 *  team's HiveManager home resolves to `harnessHome` itself (so its hive root
 *  stays `<harnessHome>/hive`, untouched). Only cloned/new teams live under
 *  `<harnessHome>/teams/<teamId>/hive`. */
export const DEFAULT_TEAM_ID = 'default';

/** One team in a multi-team install. The default team is the legacy hive
 *  (configs only — its on-disk state stays at `<harnessHome>/hive`); cloned teams
 *  get their own subdir + their own service runtime. Per-team mission/sync/cap
 *  fields fall back to the global `HarnessConfig` values when unset (so the
 *  default team behaves exactly as a single-team install always has). */
export interface TeamConfig {
  /** Stable slug + short suffix; the dir name under `teams/`. 'default' is the
   *  legacy team (special-cased to live at `<harnessHome>/hive`). */
  id: string;
  /** Display name shown in the team selector. */
  name: string;
  createdAt: number;
  /** Usually 'god'; tracked for clarity / future per-team god ids. */
  godId: string;
  /** Per-team Supabase workspace id. Unset ⇒ falls back to the global
   *  `syncWorkspaceId` (the default team shares the legacy global value). */
  syncWorkspaceId?: string;
  /** Per-team scheduled missions. Unset ⇒ falls back to the global `missions`
   *  (the default team keeps using the legacy global mission list + its
   *  lastFiredAt bookkeeping, so behavior is byte-identical to today). */
  missions?: ScheduledMission[];
  /** Per-team breaker token ceiling; unset ⇒ global `costCapTokens` fallback. */
  costCapTokens?: number;
  /** Per-team per-agent token caps; unset ⇒ global `agentTokenCaps` fallback. */
  agentTokenCaps?: Record<string, number>;
}

export interface HarnessConfig {
  /** Has the user completed the first-run onboarding? */
  onboardingComplete: boolean;
  /** Folder where the harness keeps its own state (agent metadata, logs). */
  harnessHome: string | null;
  /** Folders the user registered during onboarding (used as quick-picks). */
  registeredRepos: string[];
  /** When true, new agents are spawned with --permission-mode bypassPermissions. */
  autoMode: boolean;
  /** The command we run when spawning a new agent. */
  defaultCommand: string;
  /** Default model for newly spawned agents (e.g. 'claude-sonnet-4-6[1m]'); unset = CLI default. */
  defaultModel?: string;
  /** Master toggle for shared semantic memory (LOCAL Ollama embeddings + the
   *  workspace's Supabase pgvector index). No-op until Ollama is reachable AND
   *  team sync is on + signed in; the markdown memory always works regardless. */
  semanticMemory: boolean;
  /** Ollama server base URL for local embeddings (HuggingFace is network-blocked,
   *  so embeddings run via Ollama). Default http://localhost:11434. */
  ollamaHost?: string;
  /** Ollama embedding model tag. Default 'nomic-embed-text' (768-dim — must match
   *  the memory_chunks vector width; changing it requires a re-embed). */
  ollamaEmbedModel?: string;
  /** Recurring auto-dispatch missions handled by the scheduler. With multi-team
   *  this stays the DEFAULT team's mission list (per-team missions live on each
   *  TeamConfig and fall back here when unset). */
  missions?: ScheduledMission[];
  /** Multi-team registry. Absent on legacy installs → a single 'default' team is
   *  seeded at boot (NO-MOVE: it points at the existing `<harnessHome>/hive`). */
  teams?: TeamConfig[];
  /** One-time guard: has the 'default' TeamConfig been seeded into config.teams?
   *  NO-MOVE migration — nothing on disk moves; this only marks the legacy hive as
   *  registered under the default team so the seed never runs twice. */
  teamsMigrated?: boolean;
  /** One-time guard: has the built-in hourly ops standup been seeded into an
   *  existing install's missions? Prevents re-adding it after a user deletes it. */
  opsStandupSeeded?: boolean;
  /** One-time guard for the built-in heartbeat mission (mirrors opsStandupSeeded
   *  so a user who deletes the heartbeat doesn't get it re-added every boot). */
  heartbeatSeeded?: boolean;
  /** Hard dollar ceiling across all active agents before the circuit breaker
   *  trips. UNSET by default (Lane A #6.6b decision): the breaker trips on
   *  behavioral signals; the $-cap is purely opt-in. Legacy — the UI now sets a
   *  token cap instead (see costCapTokens); both are enforced if present. */
  costCapUsd?: number;
  /** Hard TOKEN ceiling (total tokens across all active agents) before the
   *  breaker trips. The user-facing budget — set in Settings. Opt-in like the
   *  $-cap; total = input + output + cacheRead + cacheCreation, summed across the
   *  floor (the biggest token spender is blamed). */
  costCapTokens?: number;
  /** Per-agent total-token ceiling, keyed by agent id. When an agent's own total
   *  tokens exceed its cap the breaker trips that agent alone (independent of the
   *  floor budget). Set from each agent's card in the Command Center. */
  agentTokenCaps?: Record<string, number>;
  /** Passed to every spawned agent as `--max-turns <n>` when set; unset = no cap
   *  (Claude Code's default). A coarse runaway guard independent of the breaker. */
  maxTurns?: number;
  /** Circuit-breaker thresholds (Lane A #6.6b). Unset = conservative defaults. */
  circuitBreaker?: CircuitBreakerConfig;
  /** Fire native desktop notifications on agent lifecycle events (idle finish / waiting for input). */
  notifications?: boolean;
  /** Terminal theme — mirrored into each agent's per-session Claude settings
   *  ("theme" key) at spawn so the TUI's truecolor palette matches. Scoped to
   *  harness agents only; the user's global Claude theme is never touched. */
  terminalTheme?: 'light' | 'dark';
  /** Master toggle for the Slack → orchestrator's-queue integration. */
  slackEnabled?: boolean;
  /** Slack app signing secret (Basic Information → Signing Secret). Never logged. */
  slackSigningSecret?: string;
  /** Bot token (xoxb-…) — only needed if the bot ever replies; optional for now. */
  slackBotToken?: string;
  /** Restrict ingestion to one channel id; empty/undefined = any channel. */
  slackChannelId?: string;
  /** Local HTTP port the webhook server binds to (default 3847). */
  slackPort?: number;

  // ─── Generic inbound webhook + status API ──────────────────────────────────
  /** Master toggle for the generic webhook HTTP API (POST → work, GET → status). */
  webhookEnabled?: boolean;
  /** App-generated shared secret callers echo in `x-md-webhook-secret`. Never
   *  logged, and never forwarded into the routed message/card/response. */
  webhookSecret?: string;
  /** Local HTTP port the generic webhook server binds to (default 3849). */
  webhookPort?: number;

  // ─── Supabase collaborative sync (Phase 0/1: append-only mirror) ───────────
  /** Master toggle for Supabase sync. Off by default — the app is fully local
   *  and offline-capable until the user turns this on. */
  syncEnabled?: boolean;
  /** Supabase project URL, e.g. https://xxxx.supabase.co. */
  supabaseUrl?: string;
  /** Supabase anon/publishable key. Safe to keep client-side; RLS is the real
   *  guard (PROTOTYPE: see supabase/migrations/0001 — tighten in Phase 4). */
  supabaseAnonKey?: string;
  /** Shared team id stamped on every synced row. Phase 4 turns this into a real
   *  auth-scoped `workspaces` row; for now it's a shared opaque string. */
  syncWorkspaceId?: string;

  // ─── Memory reflection (the janitor's condense half) ───────────────────────
  /** Master toggle for the in-process MemoryReflector. Default on. */
  reflectEnabled?: boolean;
  /** How often to scan agent memory.md files for condensing (default 30 min). */
  reflectIntervalMs?: number;
  /** Condense when bytes exceed this percent of the 128 KB budget (matches the
   *  janitor's TRIGGER_PCT). DECIDED: 50. */
  reflectByteTriggerPct?: number;
  /** ...OR when `## ` section count exceeds this (AND bytes > floor). DECIDED: 50. */
  reflectSectionTrigger?: number;
  /** Newest K verbatim `## ` sections kept untouched on each condense. */
  reflectRecentKeep?: number;
  /** Never condense a file smaller than this; also the section-trigger byte floor.
   *  DECIDED: 16 KB. */
  reflectMinBytes?: number;

  // ─── Agent Thoughts (the Notepad agent board author) ───────────────────────
  /** Master toggle for the in-process ThoughtsService — the harness-driven author
   *  of the Notepad "agent" board (twice-daily forward-looking ideas grounded in
   *  recent hive work). Default on; a no-op until sync is on + signed in. */
  agentThoughtsEnabled?: boolean;
}

const DEFAULTS: HarnessConfig = {
  onboardingComplete: false,
  harnessHome: null,
  registeredRepos: [],
  autoMode: true,
  defaultCommand: 'claude',
  semanticMemory: true,
  missions: [OPS_STANDUP_MISSION],
  notifications: false,
  slackEnabled: false,
  slackSigningSecret: undefined,
  slackBotToken: undefined,
  slackChannelId: undefined,
  slackPort: undefined,
  webhookEnabled: false,
  webhookSecret: undefined,
  webhookPort: undefined,
  syncEnabled: false,
  supabaseUrl: undefined,
  supabaseAnonKey: undefined,
  syncWorkspaceId: undefined,
  // Memory reflection — preventive; nobody is over threshold today, so it sits
  // dark until an agent's memory crosses one of these (the verify gate is the
  // safety for the LLM step). Thresholds DECIDED by god 2026-06-06.
  reflectEnabled: true,
  reflectIntervalMs: 1_800_000,
  reflectByteTriggerPct: 50,
  reflectSectionTrigger: 50,
  reflectRecentKeep: 12,
  reflectMinBytes: 16_384,
  // Agent Thoughts — on by default; harmless until sync is on + signed in.
  agentThoughtsEnabled: true
};

function configPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

export function readConfig(): HarnessConfig {
  const p = configPath();
  if (!existsSync(p)) return { ...DEFAULTS };
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeConfig(patch: Partial<HarnessConfig>): HarnessConfig {
  const current = readConfig();
  const next: HarnessConfig = { ...current, ...patch };
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** Wipe the persisted config back to first-run defaults so the app boots into
 *  onboarding again. Used by the "reset & start over" flow. */
export function resetConfig(): HarnessConfig {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(DEFAULTS, null, 2), 'utf8');
  return { ...DEFAULTS };
}

/** Atomic read-modify-write against config.json. `readConfig → mutate → write`
 *  runs fully synchronously (no await between the read and the write), so it can
 *  never interleave with another mutateConfig/writeConfig call — closing the
 *  lost-update window §7.9 flags once N parallel teams each persist their own
 *  mission `lastFiredAt`. Prefer this over the read-then-writeConfig(patch)
 *  pattern whenever the new value depends on the current one. */
export function mutateConfig(mutate: (cfg: HarnessConfig) => void): HarnessConfig {
  const next = readConfig();
  mutate(next);
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// ─── Multi-team helpers ──────────────────────────────────────────────────────

/** Absolute home dir for a team. The HiveManager builds its root as
 *  `join(home, 'hive')`, so the default team's home is `harnessHome` itself
 *  (root stays `<harnessHome>/hive` — NO-MOVE), and every other team lives under
 *  `<harnessHome>/teams/<id>` (root = `<harnessHome>/teams/<id>/hive`). */
export function teamHome(harnessHome: string, id: string): string {
  return id === DEFAULT_TEAM_ID ? harnessHome : join(harnessHome, 'teams', id);
}

/** All registered teams. On a legacy/un-migrated config this returns a single
 *  synthetic default team so callers always see at least one team (the on-disk
 *  seed is done by ensureDefaultTeam at boot). */
export function listTeams(cfg: HarnessConfig = readConfig()): TeamConfig[] {
  if (cfg.teams && cfg.teams.length) return cfg.teams;
  return [{ id: DEFAULT_TEAM_ID, name: 'Default', createdAt: 0, godId: 'god' }];
}

export function getTeam(id: string, cfg: HarnessConfig = readConfig()): TeamConfig | undefined {
  return listTeams(cfg).find((t) => t.id === id);
}

/** Register a new team (clone flow, Phase 2). Idempotent on id. */
export function addTeam(team: TeamConfig): HarnessConfig {
  return mutateConfig((c) => {
    const teams = c.teams ?? listTeams(c);
    if (!teams.some((t) => t.id === team.id)) teams.push(team);
    c.teams = teams;
  });
}

/** Drop a team from the registry. Team removal is OUT of v1 (no IPC surface);
 *  the helper exists for completeness + future use. Never removes 'default'. */
export function removeTeam(id: string): HarnessConfig {
  return mutateConfig((c) => {
    if (id === DEFAULT_TEAM_ID) return;
    c.teams = (c.teams ?? listTeams(c)).filter((t) => t.id !== id);
  });
}

/** Idempotently seed the 'default' TeamConfig into config.teams (NO-MOVE: nothing
 *  on disk moves — the existing `<harnessHome>/hive` stays put and the default
 *  team's home resolves to `harnessHome`). Guarded by `teamsMigrated`. `godId` is
 *  carried in by the caller (read from the live registry) so the default team
 *  records the existing god. */
export function ensureDefaultTeam(godId: string = 'god'): HarnessConfig {
  const cfg = readConfig();
  if (cfg.teamsMigrated && cfg.teams && cfg.teams.length) return cfg;
  return mutateConfig((c) => {
    if (!c.teams || !c.teams.length) {
      c.teams = [{ id: DEFAULT_TEAM_ID, name: 'Default', createdAt: Date.now(), godId }];
    }
    c.teamsMigrated = true;
  });
}

/** One-time seed of the built-in ops-standup + heartbeat missions into the GLOBAL
 *  mission list (the default team's). Guarded by `opsStandupSeeded`/`heartbeatSeeded`
 *  so a user who deletes either doesn't get it re-added every boot. Stamps
 *  lastFiredAt = now so the first fire waits a full interval. (Clones seed their
 *  own missions at clone time; this only seeds the default/global list.) */
export function ensureDefaultMissions(): void {
  const cfg = readConfig();
  if (!cfg.opsStandupSeeded) {
    const missions = cfg.missions ?? [];
    const has = missions.some((m) => m.id === OPS_STANDUP_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...OPS_STANDUP_MISSION, lastFiredAt: Date.now() }],
      opsStandupSeeded: true
    });
  }
  const cfg2 = readConfig();
  if (!cfg2.heartbeatSeeded) {
    const missions = cfg2.missions ?? [];
    const has = missions.some((m) => m.id === HEARTBEAT_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...HEARTBEAT_MISSION, lastFiredAt: Date.now() }],
      heartbeatSeeded: true
    });
  }
}

/** Per-team mission list with global fallback. The default team has no own
 *  `missions` (it keeps using the global list), so this returns `cfg.missions`
 *  for it and the team's own list for clones. */
export function teamMissions(id: string, cfg: HarnessConfig = readConfig()): ScheduledMission[] {
  return getTeam(id, cfg)?.missions ?? cfg.missions ?? [];
}

/** Per-team Supabase workspace id with global fallback. */
export function teamSyncWorkspaceId(id: string, cfg: HarnessConfig = readConfig()): string {
  return getTeam(id, cfg)?.syncWorkspaceId ?? cfg.syncWorkspaceId ?? '';
}

/** Per-team breaker token cap with global fallback. */
export function teamCostCapTokens(id: string, cfg: HarnessConfig = readConfig()): number | undefined {
  return getTeam(id, cfg)?.costCapTokens ?? cfg.costCapTokens;
}

/** Per-team per-agent token caps with global fallback. */
export function teamAgentTokenCaps(id: string, cfg: HarnessConfig = readConfig()): Record<string, number> | undefined {
  return getTeam(id, cfg)?.agentTokenCaps ?? cfg.agentTokenCaps;
}

/** Model ids by tier (Lane A #6.4). Kept in sync with AGENT_MODELS in
 *  src/renderer/src/store/config.ts. */
const MODEL_GOD = 'claude-opus-4-8';                  // orchestration — highest capability
const MODEL_WORKER = 'claude-sonnet-4-6';             // general execution
const MODEL_HELPER = 'claude-haiku-4-5-20251001';     // narrow, cheap helpers

/** Minimal structural shape for tiering — a subset of AgentMeta so config.ts
 *  stays free of a hive.ts import. */
export interface RoleHint {
  isGod?: boolean;
  role?: string;
  capabilities?: string[];
}

/** Default model for an agent given its role (Lane A #6.4): Opus for the god,
 *  Haiku for narrow helpers (triage / routing / verification / formatting),
 *  Sonnet for general workers. Returns a model id (matching AGENT_MODELS) or
 *  undefined to fall back to the CLI default. This is only a DEFAULT — an
 *  explicit per-agent model selection always wins. */
export function modelForRole(meta: RoleHint): string | undefined {
  if (meta.isGod) return MODEL_GOD;
  const hay = `${meta.role ?? ''} ${(meta.capabilities ?? []).join(' ')}`.toLowerCase();
  if (/\b(triage|rout|verif|lint|format|summar|classif|label)/.test(hay)) return MODEL_HELPER;
  return MODEL_WORKER;
}

/** Auto-suggested command string given current autoMode preference.
 *  Provider-aware: Claude gets --permission-mode bypassPermissions; Codex gets
 *  --full-auto; custom providers receive no extra flags. */
export function commandForAutoMode(
  config: HarnessConfig,
  provider?: AgentProvider
): string {
  if (!config.autoMode) return config.defaultCommand;
  const p = provider ?? inferAgentProvider(config.defaultCommand);
  const flag = autoModeFlagForProvider(p);
  return flag ? `${config.defaultCommand} ${flag}` : config.defaultCommand;
}

/** Ensure harnessHome exists on disk. */
export function ensureHarnessHome(path: string): { ok: boolean; error?: string } {
  try {
    mkdirSync(path, { recursive: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Idempotently pre-accept Claude Code's first-run prompts so agents spawned with
 *  `--permission-mode bypassPermissions` start cleanly. Without this, a fresh
 *  install shows an interactive "WARNING: Bypass Permissions mode … 1. No, exit /
 *  2. Yes, I accept" prompt that the PTY can't answer in time, so the agent exits
 *  code 1 on its own (reported by multiple users).
 *
 *  Two separate gates, written only when they aren't already satisfied (so we
 *  rarely touch files a running `claude` also writes):
 *   1. `~/.claude/settings.json` → `skipDangerousModePermissionPrompt` +
 *      `skipAutoPermissionPrompt` — these gate the bypass-mode warning (global).
 *   2. `~/.claude.json` → `projects[cwd].hasTrustDialogAccepted` — the per-folder
 *      "do you trust the files in this folder?" dialog. */
export function ensureClaudePermissionsAccepted(cwd?: string): void {
  const home = homedir();
  if (!home) return;
  // 1) Global bypass-mode warning gate.
  try {
    const dir = join(home, '.claude');
    const p = join(dir, 'settings.json');
    let s: Record<string, unknown> = {};
    if (existsSync(p)) {
      try { s = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { s = {}; }
    }
    if (s.skipDangerousModePermissionPrompt !== true || s.skipAutoPermissionPrompt !== true) {
      s.skipDangerousModePermissionPrompt = true;
      s.skipAutoPermissionPrompt = true;
      mkdirSync(dir, { recursive: true });
      writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
    }
  } catch { /* best-effort; never block a spawn */ }
  // 2) Per-folder trust dialog gate (only when this cwd isn't already trusted).
  if (cwd) {
    try {
      const p = join(home, '.claude.json');
      let c: { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> } = {};
      if (existsSync(p)) {
        try { c = JSON.parse(readFileSync(p, 'utf8')); } catch { c = {}; }
      }
      if (c.projects?.[cwd]?.hasTrustDialogAccepted !== true) {
        c.projects = c.projects ?? {};
        c.projects[cwd] = { ...(c.projects[cwd] ?? {}), hasTrustDialogAccepted: true };
        writeFileSync(p, JSON.stringify(c, null, 2), 'utf8');
      }
    } catch { /* best-effort */ }
  }
}
