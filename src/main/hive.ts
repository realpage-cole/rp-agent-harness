/**
 * The Hive — the on-disk multi-agent coordination layer.
 *
 * Lives under `<harnessHome>/hive/` as a single git repo that ONLY this main
 * process commits to (agents never call git — they just write files). See
 * HIVE.md for the full design. Responsibilities:
 *   - per-agent workspace (identity.md, memory.md, inbox/, outbox/, cursor.json)
 *   - a roster (registry.json), shared blackboard (board.md), task ledger,
 *     and an append-only event log (log.jsonl)
 *   - a router that drains each agent's outbox into recipients' inboxes
 *
 * Human-in-the-loop is native to each agent's Claude Code session: permission
 * prompts surface in the agent's own terminal (and can be approved remotely via
 * `/remote-control`). The hive keeps no separate approval queue — a message aimed
 * at "human" is routed to the god/orchestrator, the human's proxy on the team.
 *   - single-committer git with retry/backoff + stale-lock recovery
 *
 * Everything here runs in the Electron main process.
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  readdirSync, statSync, rmSync, appendFileSync
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import type { AgentUsageSample } from './usage';
import { COMMAND_GROUPS } from '../shared/claudeCommands';
import {
  isClaudeProvider,
  isHiveAwareProvider,
  canReceiveInbox,
  providerPreset,
  type AgentProvider
} from '../shared/agentProvider';
// Type-only import (no runtime edge) — keeps the DECOUPLING CONTRACT: hive.ts
// owns the shape↔file mapping behind a HiveBridge; sync/state.ts never imports
// hive.ts. The StateRows interface is the wire shape readStateRows() returns.
import type { StateRows } from './sync/types';

// ─── Types ──────────────────────────────────────────────────────────────────

export type MessageAct = 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';

export interface HiveMessage {
  id: string;
  conversation: string;
  in_reply_to: string | null;
  from: string;
  to: string;                 // an agentId, 'god', or 'broadcast'
  act: MessageAct;
  subject: string;
  body: string;
  hops: number;
  requires_reply: boolean;
  needs_human: boolean;
  created_at: string;
}

/** One question→answer exchange with the human, recorded ON the task card so
 *  the decision trail stays with the work it unblocked. */
export interface HumanQA {
  q: string;
  a?: string;
  askedAt?: string;
  answeredAt?: string;
}

export interface HiveTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  dependsOn: string[];
  priority: number;
  createdAt: string;
  /** First-class human feedback: the god appends {q} when a card can only
   *  proceed with the human's input (status goes blocked); the harness UI
   *  fills in {a}. The full history stays on the card forever. */
  humanQA?: HumanQA[];
  /** Outcome summary, surfaced by the Slack done-notifier when this card reaches
   *  'done'. Optional; the notifier falls back to description/title. */
  result?: string;
  /** Set when this task originated from a Slack message — the thread the
   *  done-summary reply is posted back into. Consumed OUTBOUND only; populating
   *  it is the inbound/kanban side's job and does not affect routing. */
  slack?: { channel: string; thread_ts: string };
  /** Set when this task originated from a generic webhook POST. Stores the SHA-256
   *  of the capability token (never the raw token — that's returned to the caller
   *  once and never persisted), so a GET status lookup can match by hashing the
   *  presented token. Read-only capability: it never widens routing or exposure. */
  webhook?: { tokenHash: string };
  /** Per-card last-write stamp (ms epoch), used as the LAST-WRITER-WINS key when
   *  syncing the task ledger across machines (Phase 3). ADDITIVE: stamped in
   *  `writeTasks` on local writes and carried in/out of the synced payload; old
   *  cards without it default to 0 (always loses to a stamped remote). */
  updatedAt?: number;
  /** Who last touched this card (agent id / 'human' / 'system'), carried across
   *  sync for provenance. Cosmetic; never affects routing. ADDITIVE/optional. */
  updatedBy?: string;
}

export interface AgentMeta {
  id: string;
  name: string;
  /** Which CLI this agent runs on. Defaults to 'claude' when unset (legacy). */
  provider?: AgentProvider;
  role?: string;
  capabilities?: string[];
  cwd: string;
  isGod?: boolean;
  /** The orchestrator's prep assistant — enriches prompts and forwards them to
   *  the orchestrator. Send-only: excluded from broadcast fan-out so it never
   *  drains an inbox. */
  isAssistant?: boolean;
  /** Operator-editable system-prompt addendum, set from the dashboard. Persisted
   *  on the registry entry and appended LAST to the composed system prompt at
   *  spawn (see injectedPrompt). PRESERVED across respawns (ensureAgent merge) so
   *  a respawn never wipes the operator's edits. '' / undefined = none. */
  customPrompt?: string;
}

export interface RegistryAgent extends AgentMeta {
  status: 'idle' | 'working' | 'blocked' | 'gone';
  lastSeen: number;
  /** True once the agent's terminal/PTY tab is closed. The record is retained
   *  (not deleted) so its history/memory survive; only agents with a live PTY
   *  are 'active'. Broadcast fan-out + roster reads skip archived agents. */
  archived?: boolean;
  /** Most recent Claude Code session_id seen for this agent (Lane A #6.6a),
   *  captured from hook payloads. Doubles as the `--resume` key (idempotent
   *  resume after a crash/restart) AND the cost accounting/dedup key on every
   *  AgentUsageSample / cost-ledger row. */
  sessionId?: string;
}

export interface Registry {
  godId: string | null;
  agents: Record<string, RegistryAgent>;
  /** ADDITIVE hive-level metadata (Phase 3 shared-state sync). Old installs
   *  without it default to {} — every reader tolerates its absence. */
  meta?: RegistryMeta;
}

/** Hive-level sync bookkeeping carried in registry.json. ADDITIVE: an old
 *  registry.json has no `meta` block and is read with all-zero/empty defaults. */
export interface RegistryMeta {
  /** Last-write stamp (ms epoch) of board.md, the LAST-WRITER-WINS key for the
   *  blackboard. The harness has no board writer (god agents edit board.md on
   *  disk directly), so `readStateRows` detects content changes by hash and
   *  bumps this; defaults to 0 when never stamped. */
  boardUpdatedAt?: number;
  /** sha1 of the board.md body at the time `boardUpdatedAt` was last set, so a
   *  content change can be detected without a write hook. */
  boardHash?: string;
}

/** Build env + extra spawn args that make an agent process hive-aware. */
export interface SpawnInjection {
  args: string[];
  env: Record<string, string>;
}

const HOP_CAP = 12;

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/** Filesystem- and sort-safe timestamp, e.g. 2026-05-30T14-03-11-123Z. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function shortRand(): string {
  return randomBytes(3).toString('hex');
}

/** Non-memory files kept out of the hive's git repo (Claude Code hooks config,
 *  cursor, raw inbox/outbox JSON) — bulky/noisy churn that shouldn't be committed.
 *  Dropped as a per-agent .gitignore on birth here. (Only memory.md is embedded
 *  into the shared semantic memory, so the index never sees these either.) */
const MINE_IGNORE_LINES = ['settings.json', 'cursor.json', 'inbox/', 'outbox/', '.cchome/'];

/** Idempotently ensure `<agentDir>/.gitignore` excludes the non-memory files.
 *  Append-only: writes only the missing lines, leaving any existing entries. */
function ensureMineIgnore(agentDir: string): void {
  const path = join(agentDir, '.gitignore');
  let existing = '';
  try { if (existsSync(path)) existing = readFileSync(path, 'utf8'); } catch { return; }
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = MINE_IGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return;
  const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
  try { writeFileSync(path, prefix + missing.join('\n') + '\n', 'utf8'); } catch { /* best-effort */ }
}

// ─── HiveManager ────────────────────────────────────────────────────────────

export class HiveManager {
  /** Which team this hive belongs to. Multi-team: each team gets its own
   *  HiveManager whose `getHome` resolves to that team's home (default team →
   *  harnessHome; clones → `<harnessHome>/teams/<id>`), so the root + every
   *  root-relative read/write is team-correct with no per-callsite edits. Used
   *  for logging and the teamId stamp on emitted renderer events. */
  readonly teamId: string;

  /**
   * @param getHome  Lazily resolve this team's home so the hive follows config changes.
   * @param emit     Optional sink for renderer-facing events (set by the main
   *                 process to `webContents.send`). Used to surface routed
   *                 messages in the dashboard; a no-op in tests/headless. The
   *                 main process wraps this to stamp `teamId` on every payload.
   * @param teamId   Owning team id (defaults to the legacy 'default' team).
   */
  constructor(
    private getHome: () => string | null,
    private emit?: (channel: string, payload: unknown) => boolean | void,
    teamId = 'default'
  ) {
    this.teamId = teamId;
  }

  private routerTimer: NodeJS.Timeout | null = null;

  /** The embedded OTLP collector's loopback URL, set by the main process once the
   *  collector is bound (telemetry.ts). null = telemetry off → no OTel env is
   *  injected at spawn (the transcript reconciler remains the cost source). */
  private _otelEndpoint: string | null = null;
  /** The semanticMemory flag last passed to ensureAgent — so getAgentPrompt's
   *  computed `base` matches what was actually injected at the last spawn. The
   *  flag is hive-wide (driven by config.semanticMemory), so a single value is
   *  representative; defaults false until the first spawn. */
  private _semanticMemory = false;
  /** Point newly-spawned agents at the live telemetry collector. Call after the
   *  collector starts; only affects spawns made afterwards. */
  setOtelEndpoint(url: string | null): void {
    this._otelEndpoint = url;
  }
  /** The collector URL agents are pointed at, or null when telemetry is off. */
  otelEndpoint(): string | null {
    return this._otelEndpoint;
  }

  // — paths —
  root(): string | null {
    const home = this.getHome();
    return home ? join(home, 'hive') : null;
  }
  enabled(): boolean {
    return this.root() !== null;
  }
  private agentDir(id: string): string {
    return join(this.root()!, 'agents', id);
  }
  /** IPC endpoint the cth-hook shim talks to (Phase 1 autonomy).
   *  On POSIX this is a Unix-domain socket file under the hive root. On Windows,
   *  Node's `net` IPC uses named pipes (a flat `\\.\pipe\` namespace, not the
   *  filesystem), so a raw file path fails to bind with EACCES — derive a stable,
   *  per-root pipe name instead. Both the server (`listen`) and the shim
   *  (`createConnection`) read this same value, so they stay in sync. */
  sockPath(): string | null {
    const root = this.root();
    if (!root) return null;
    if (process.platform === 'win32') {
      const id = createHash('sha1').update(root).digest('hex').slice(0, 12);
      return `\\\\.\\pipe\\munder-difflin-${id}`;
    }
    return join(root, 'hooks.sock');
  }
  private shimPath(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'cth-hook.cjs') : null;
  }

  // — bootstrap —

  /** Create the hive skeleton + git repo if missing. Idempotent. */
  ensureHive(): void {
    const root = this.root();
    if (!root) return;
    mkdirSync(join(root, 'agents'), { recursive: true });

    const protocol = join(root, 'PROTOCOL.md');
    if (!existsSync(protocol)) writeFileSync(protocol, PROTOCOL_MD, 'utf8');

    const registry = join(root, 'registry.json');
    if (!existsSync(registry)) {
      this.writeJson(registry, { godId: null, agents: {} } as Registry);
    }
    const board = join(root, 'board.md');
    if (!existsSync(board)) {
      writeFileSync(board, '# Hive board\n\n_Shared plans live here. The god agent is the scribe._\n', 'utf8');
    }
    // The "team pulse" snippet teammates see in the Notepad. The god/orchestrator
    // keeps it current each standup (1-3 lines on its user + the team's recent
    // activity); the sync beat pushes it to member_notes. Seeded with a placeholder
    // so a teammate never sees a blank pulse before the first standup.
    const pulse = join(root, 'pulse.md');
    if (!existsSync(pulse)) {
      writeFileSync(pulse, '_No pulse yet — the orchestrator updates this each standup._\n', 'utf8');
    }
    const tasks = join(root, 'tasks.json');
    if (!existsSync(tasks)) this.writeJson(tasks, { tasks: [] });
    const log = join(root, 'log.jsonl');
    if (!existsSync(log)) writeFileSync(log, '', 'utf8');

    // The Claude Code command reference the orchestrator consults (refreshed each bootstrap
    // so it tracks the bundled list).
    writeFileSync(join(root, 'COMMANDS.md'), COMMANDS_MD, 'utf8');

    // Keep the churny/ephemeral live files out of the hive git repo.
    const gitignore = join(root, '.gitignore');
    const want = ['fleet.json', 'hooks.sock', '.DS_Store'];
    let lines: string[] = [];
    if (existsSync(gitignore)) { try { lines = readFileSync(gitignore, 'utf8').split('\n'); } catch { lines = []; } }
    const missing = want.filter((w) => !lines.includes(w));
    if (missing.length) writeFileSync(gitignore, [...lines.filter(Boolean), ...missing].join('\n') + '\n', 'utf8');

    // The hook shim: a dumb pipe between a `claude` hook and our UDS. Refreshed
    // on every bootstrap so it tracks code changes.
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(this.shimPath()!, HOOK_SHIM, 'utf8');

    if (!existsSync(join(root, '.git'))) {
      this.git(['init', '-q'], root);
      this.commit('hive: init');
    }
  }

  /**
   * Throw if the user has not run `claude login`. Call before spawning any agent
   * so the UI can surface a clear message instead of letting agents spawn and fail
   * silently with auth errors. Checks for the oauthAccount key in ~/.claude.json.
   */
  assertLoggedIn(): void {
    try {
      const cfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
      if (cfg.oauthAccount) return;
    } catch { /* file missing → not logged in */ }
    throw new Error('Not logged in to Claude Code. Run `claude login` in your terminal first.');
  }

  /**
   * Ensure an agent's workspace + registry entry, returning the spawn injection
   * (provider-specific args + env) that makes the process hive-aware.
   */
  ensureAgent(meta: AgentMeta, opts: { semanticMemory?: boolean; theme?: 'light' | 'dark' } = {}): SpawnInjection {
    const root = this.root();
    if (!root) return { args: [], env: {} };
    this.ensureHive();
    this._semanticMemory = opts.semanticMemory ?? false;

    const dir = this.agentDir(meta.id);
    mkdirSync(join(dir, 'inbox', '.done'), { recursive: true });
    mkdirSync(join(dir, 'outbox', '.sent'), { recursive: true });

    const identity = join(dir, 'identity.md');
    writeFileSync(identity, this.identityText(meta), 'utf8'); // refresh on each spawn

    const memory = join(dir, 'memory.md');
    if (!existsSync(memory)) {
      writeFileSync(memory, `# Memory — ${meta.name} (${meta.id})\n\n_Append durable facts, decisions, and context below._\n`, 'utf8');
    }
    ensureMineIgnore(dir); // keep settings.json / cursor / messages out of the hive git
    const cursor = join(dir, 'cursor.json');
    if (!existsSync(cursor)) this.writeJson(cursor, { lastProcessed: null });

    // upsert registry
    const reg = this.registry();
    const existing = reg.agents[meta.id];
    reg.agents[meta.id] = {
      ...meta,
      capabilities: meta.capabilities ?? [],
      role: meta.role ?? (meta.isGod ? 'orchestrator' : 'agent'),
      // PRESERVE the operator's prompt addendum across respawns: a (re)spawn that
      // doesn't carry a customPrompt must NOT wipe the one the operator saved.
      customPrompt: meta.customPrompt ?? existing?.customPrompt,
      status: 'idle',
      // A (re)spawn always means a live terminal — clear any prior archived flag.
      archived: false,
      lastSeen: Date.now()
    };
    if (meta.isGod) reg.godId = meta.id;
    this.writeJson(join(root, 'registry.json'), reg);

    this.appendLog({ kind: 'spawn', agentId: meta.id, name: meta.name, isGod: !!meta.isGod });
    this.commit(`hive: register ${meta.id}`);

    const env: Record<string, string> = {
      AGENT_ID: meta.id,
      AGENT_NAME: meta.name,
      HIVE_ROOT: root,
      AGENT_DIR: dir
    };

    const claudeProvider = isClaudeProvider(meta.provider ?? 'claude');

    // Non-hive-aware providers (Antigravity's `agy`, OpenAI's `codex`) don't
    // understand Claude Code's flags or hook protocol — no telemetry, no
    // `--settings` hooks. But they DO take an INITIAL prompt to orient the
    // session, so we still inject the same hive identity+protocol as the first
    // turn — the closest thing to `--append-system-prompt` these CLIs offer
    // (after the first turn the session continues normally). This is what makes
    // a Gemini/Codex worker hive-aware without Claude installed at all.
    //
    // How the prompt rides in differs by CLI:
    //  - agy takes it under a flag (`agy -i "<prompt>"`) → push [flag, prompt].
    //  - codex takes it POSITIONALLY (`codex "<prompt>"`, no flag) → push the
    //    bare prompt as a trailing arg (node-pty passes argv literally, so it
    //    arrives as one positional argument after codex's own flags).
    if (!isHiveAwareProvider(meta.provider)) {
      const preset = providerPreset(meta.provider ?? 'claude');
      const flag = preset.initialPromptFlag;
      const prompt = this.injectedPrompt(meta, dir, root, opts.semanticMemory ?? false);
      // Only agy exposes a Claude-compatible lifecycle-hook surface we can bridge
      // (PreToolUse/PostToolUse/Stop/…). Install the agy-hook shim so a Gemini
      // worker gets the SAME live status + inbox-drain Claude does — on the
      // subscription, no SDK/API key. Codex has NO such hooks and cannot reuse the
      // bridge, so it is NOT installed for codex; codex relies on the renderer's
      // idle inbox-wake nudge to drain its inbox (see useHive.ts) and on its outbox
      // being drained provider-agnostically by the router.
      if (meta.provider === 'antigravity') {
        const sock = this.sockPath();
        if (sock) {
          env.HIVE_SOCK = sock;
          try { this.installAgyHooks(); } catch (e) { console.error('[hive] installAgyHooks failed:', e); }
        }
      }
      // Inject the protocol text whichever way the CLI accepts it. If a provider
      // somehow exposes neither a flag nor a positional prompt, spawn bare.
      if (flag) return { args: [flag, prompt], env };
      // Positional initial prompt (codex). Append as a trailing argv element.
      return { args: [prompt], env };
    }

    // Stage 7A — first-party Claude Code telemetry → the embedded loopback OTLP
    // collector (telemetry.ts). Pure env, no --settings change. Only injected
    // for Claude Code once the collector is up (otelEndpoint set), so telemetry-
    // off installs and non-Claude providers spawn exactly as before.
    if (claudeProvider && this._otelEndpoint) {
      env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
      env.OTEL_METRICS_EXPORTER = 'otlp';
      env.OTEL_LOGS_EXPORTER = 'otlp';
      env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
      env.OTEL_EXPORTER_OTLP_ENDPOINT = this._otelEndpoint;
      env.OTEL_METRIC_EXPORT_INTERVAL = '5000'; // 5s — near-live without spamming
      env.OTEL_LOGS_EXPORT_INTERVAL = '2000';
      env.OTEL_RESOURCE_ATTRIBUTES = `agent.id=${meta.id},agent.name=${meta.name}`;
    }
    const args: string[] = [];
    if (!claudeProvider) return { args, env };

    // RES-4 — FULL per-agent tool isolation: each WORKER gets its own Claude config
    // home so it only sees the MCP servers + plugins provisioned into it
    // (hive/agent-tooling.json + hive/bin/provision_agent_tools.py). god is the
    // orchestrator and intentionally keeps the shared home (full access).
    if (!meta.isGod) {
      const cchome = join(dir, '.cchome');
      mkdirSync(cchome, { recursive: true });
      env.CLAUDE_CONFIG_DIR = cchome;
      // Seed onboarding + workspace trust once so a fresh isolated home never prompts.
      // Also forward the oauthAccount block from the shared ~/.claude.json so the
      // worker's isolated home matches the keychain entry (token lives in the macOS
      // keychain under service "Claude Code" / OS username — shared across all
      // processes running as this user, so no token copy is needed).
      const cfgJson = join(cchome, '.claude.json');
      if (!existsSync(cfgJson)) {
        let oauthAccount: unknown = undefined;
        try {
          const sharedCfg = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'));
          oauthAccount = sharedCfg.oauthAccount;
        } catch { /* no shared config — worker will prompt for login */ }
        this.writeJson(cfgJson, {
          hasCompletedOnboarding: true,
          projects: { [root]: { hasTrustDialogAccepted: true } },
          mcpServers: {},
          ...(oauthAccount ? { oauthAccount } : {})
        });
      }
    }

    args.push('--append-system-prompt', this.injectedPrompt(meta, dir, root, opts.semanticMemory ?? false));

    // Phase 1 — autonomy: attach lifecycle hooks via --settings (no edits to the
    // user's repo) so the agent reports activity and drains its inbox on Stop.
    const sock = this.sockPath();
    const shim = this.shimPath();
    if (sock && shim) {
      env.HIVE_SOCK = sock;
      const settingsPath = join(dir, 'settings.json');
      this.writeJson(settingsPath, this.hookSettings(shim, opts.theme));
      args.push('--settings', settingsPath);
    }
    return { args, env };
  }

  /**
   * Flip an agent's archived flag and persist the registry. Closing a terminal
   * tab archives the agent (retained + flagged, NOT deleted); a (re)spawn clears
   * it. No-op if the agent isn't registered or the flag is already set the way
   * asked. Best-effort — never throws, so a dying PTY/kill handler can't crash.
   */
  setArchived(id: string, archived: boolean): void {
    const root = this.root();
    if (!root) return;
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent || agent.archived === archived) return;
      agent.archived = archived;
      agent.lastSeen = Date.now();
      this.writeJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'archive', agentId: id, archived });
      this.commit(`hive: ${archived ? 'archive' : 'unarchive'} ${id}`);
    } catch { /* best-effort — never crash a lifecycle handler */ }
  }

  /**
   * Persist the agent's Claude Code session_id (Lane A #6.6a). Captured from hook
   * payloads; written only when it actually changes (a new session), so this is a
   * no-op on the vast majority of hook events. The id is the `--resume` key for
   * idempotent resume after a crash/restart AND the accounting/dedup key for cost
   * samples. Best-effort — never throws into a hook handler.
   */
  recordSession(agentId: string, sessionId: string): void {
    const root = this.root();
    if (!root || !sessionId) return;
    try {
      const reg = this.registry();
      const agent = reg.agents[agentId];
      if (!agent || agent.sessionId === sessionId) return; // unknown agent or unchanged → no write
      agent.sessionId = sessionId;
      agent.lastSeen = Date.now();
      this.writeJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'session', agentId, sessionId });
      this.commit(`hive: session ${agentId}`);
    } catch { /* best-effort — never crash a hook handler */ }
  }

  /** The last known session_id for an agent, or undefined. Used to build a
   *  `claude --resume <id>` spawn so a restarted agent resumes its thread. */
  lastSession(agentId: string): string | undefined {
    return this.registry().agents[agentId]?.sessionId;
  }

  /** Claude Code settings that route every relevant hook through the shim. */
  private hookSettings(shim: string, theme?: 'light' | 'dark'): unknown {
    const cmd = `node "${shim}"`;
    const entry = (matcher?: string) => ({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: cmd }]
    });
    return {
      // Match the TUI's truecolor palette to the harness terminal theme —
      // PER SESSION, so the user's global Claude theme (their own terminals
      // outside the app) is never touched.
      ...(theme ? { theme } : {}),
      // The status line gets the session status JSON after every response —
      // including context_window.{total_input_tokens,context_window_size},
      // the only clean programmatic source for the session's REAL context
      // window. The shim prints a compact in-terminal gauge and forwards the
      // payload to the harness (agent-card context gauge, exact limit).
      statusLine: { type: 'command', command: `${cmd} --status`, padding: 0 },
      hooks: {
        Stop: [entry()],
        SubagentStop: [entry()],
        PreToolUse: [entry('*')],
        PostToolUse: [entry('*')],
        UserPromptSubmit: [entry()],
        Notification: [entry()],
        SessionStart: [entry()],
        // #5C: surface mid-`/compact` so an agent boxing up its context reads as
        // 'compacting' in the dashboard instead of looking frozen.
        PreCompact: [entry()],
        PostCompact: [entry()]
      }
    };
  }

  /**
   * Drain an agent's inbox for the Stop hook. Returns whether to block-to-continue
   * and the message text to feed back. Uses the per-agent cursor so a message is
   * surfaced exactly once (no infinite loop).
   */
  drainForStop(agentId: string): { block: boolean; reason?: string } {
    const dir = this.agentDir(agentId);
    if (!existsSync(dir)) return { block: false };
    const cursorPath = join(dir, 'cursor.json');
    const cursor = this.readJson<{ lastProcessed: string | null }>(cursorPath, { lastProcessed: null });
    const fresh = this.inbox(agentId)
      .filter((m) => !cursor.lastProcessed || m.id > cursor.lastProcessed)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (fresh.length === 0) return { block: false };

    cursor.lastProcessed = fresh[fresh.length - 1].id;
    this.writeJson(cursorPath, cursor);
    this.appendLog({ kind: 'drain', agentId, count: fresh.length });

    const lines = fresh.map((m) => `- [from ${m.from}, ${m.act}] ${m.subject}: ${m.body}`).join('\n');
    const reason = [
      `You have ${fresh.length} new hive message(s) in your inbox. Address them before finishing:`,
      lines,
      `Open the files in ${dir}/inbox/ for full detail, act on each, then move handled ones to inbox/.done/. Reply via your outbox if a message requires it.`
    ].join('\n');
    return { block: true, reason };
  }

  // — agent-facing text —

  private identityText(meta: AgentMeta): string {
    const caps = (meta.capabilities ?? []).join(', ') || '—';
    return [
      `# ${meta.name} (${meta.id})`,
      '',
      `- Role: ${meta.role ?? (meta.isGod ? 'orchestrator (god)' : 'agent')}`,
      `- Capabilities: ${caps}`,
      `- Working directory: ${meta.cwd}`,
      meta.isGod ? '- You are the **god / orchestrator**. You run the team — keep awareness of the whole team, delegate execution, and personally own only the important calls (decomposition, sign-offs, conflicts, integration), not the grunt work.' : '',
      meta.isGod ? '- Monitor the team with `fleet.json` (live per-agent status/tokens/cost/breaker) and `registry.json`; full command reference in `COMMANDS.md`. `claude agents` does NOT list your hive siblings.' : '',
      ''
    ].filter(Boolean).join('\n');
  }

  /**
   * The system-prompt prefix injected into every spawn via --append-system-prompt.
   *
   * 🔒 PROMPT-CACHE INVARIANT — keep this prefix VOLATILE-FREE. It interpolates
   * only values stable for an agent's whole lifetime (name, id, dir, root,
   * semanticMemory). Do NOT add dates, UUIDs, counters, board/registry state, or
   * any `Date.now()`-derived text here: a prefix that changes per spawn defeats
   * Anthropic's prompt cache (re-priming the whole system prompt every turn).
   * Volatile context belongs on the live channels — the inbox (hive messages) and
   * the PTY — never baked into this prefix. (Lane A #6.1.)
   */
  private injectedPrompt(meta: AgentMeta, dir: string, root: string, semanticMemory: boolean): string {
    const memoryLine = semanticMemory
      ? 'Shared memory: durable facts you append to memory.md are embedded (locally, via Ollama — nothing leaves the machine) into a team-wide semantic memory spanning every teammate, session, and project. Write what genuinely matters there — it makes the whole hive recall more by meaning over time. This is the living memory layer; treat memory.md as long-term knowledge, not a scratchpad.'
      : '';
    const godLine = meta.isGod
      ? 'You are the GOD / ORCHESTRATOR of this hive — your job is to ORCHESTRATE, not to implement: maintain live situational awareness and delegate the work. (1) AWARENESS — always know what is going on: keep an accurate picture of every agent (active vs archived/idle), the task board, and all in-flight work; drain your inbox continually and triage every other agent\'s requests, answering clarifications so the team runs autonomously. (2) DELEGATE — decompose work and fan it out to the hive agents via their inboxes (route messages and assign owners; do not do their jobs); do NOT take on grunt implementation yourself. (3) OWN ONLY THE IMPORTANT, high-leverage things — task decomposition, dispatch decisions, sign-offs, conflict resolution, branch integration, and final QA — and remain the sole scribe of board.md. You are otherwise fully autonomous — there is NO separate approval queue. For the genuinely critical (destructive actions, spending real money, scope changes, unresolvable conflicts), ask the human directly in your own session and let the tool-permission prompt gate the action; the human approves natively, including remotely from their phone via /remote-control. Keep the team unblocked. When you DISPATCH a task, write it as a 4-part contract so the agent can run autonomously: (1) OBJECTIVE — the concrete goal; (2) OUTPUT — the expected deliverable/format; (3) TOOLS — what to use or avoid, and any references to read instead of re-deriving; (4) BOUNDARIES — scope limits + the definition of done. Pass references (file paths, message ids, board sections), not pasted content — keep dispatches short. CAPABILITY CHECK FIRST — before you decompose or delegate any task, assess whether your CURRENT roster (the active, non-archived agents in registry.json/fleet.json) actually covers the skills AND capacity the task needs. If there is a gap, do NOT silently push the work onto an ill-suited agent or take it on yourself: STOP and recommend to the human exactly which agent(s) to spin up — name them by preset id (architect, backend, frontend, data-ml, infra-devops, rp-integrations, reviewer, qa-verify, researcher) or describe a custom one, say what each is for and why the current roster cannot cover it, and tell them to spawn it from the Add Agent dashboard (presets are one click). Only proceed once the gap is filled or the human explicitly says to continue with the agents on hand. Re-run this check whenever the task scope grows.'
        + ` MONITOR the team by reading ${root}/fleet.json (live per-agent tokens, cost, status, last tool, breaker level, inbox backlog) and ${root}/registry.json — note that running 'claude agents' will NOT list your hive's sibling agents. A full Claude Code command reference is at ${root}/COMMANDS.md (slash commands act ONLY on your own session; CLI commands run in your shell and can target the fleet). You periodically receive scheduler / "Heartbeat" standup requests — on each, review every agent via fleet.json, re-engage anyone stalled, over-budget, or breaker-armed, and keep board.md and tasks.json accurate. In tasks.json, ALWAYS set each task's "assignee" to the worker's agent id the moment you dispatch it, and NEVER clear it on status changes — a done card must still say who did the work (the human reads the board by who-did-what). HUMAN FEEDBACK is first-class in the ledger: when a task can only proceed with the human's input — a QUESTION to answer OR an ACTION only the human can perform (create an account, approve a purchase, provide credentials/screenshots, test on their device) — set its status to "blocked" and append the concrete ask to the card's "humanQA" array (push {"q":"...","askedAt":"<iso>"}; phrase actions as clear to-dos; keep every past entry — the history documents the card's decisions). The harness surfaces open questions on the dashboard's Needs-you queue; the human's answer lands in the same entry ("a") AND arrives as an inbox message to you — read it, act on it, and unblock the card so work continues. Do NOT park human questions in separate files (no HumanQuestion.md) and never sit waiting on the human in your own session. TEAM PULSE — each standup, keep ${root}/pulse.md updated with a 1-3 line status of your user plus the team's recent activity; this is the snippet teammates see as your "Team pulse" in the shared Notepad, so keep it current and human-readable. Steward the token budget.`
      : meta.isAssistant
      ? 'You are the orchestrator\'s PREP ASSISTANT. You will be handed short, possibly vague instructions (each begins with "ENRICH TASK:"). For each one: (1) figure out which project it concerns and cd into the most relevant repo — you start in the orchestrator\'s home directory; (2) gather concrete context READ-ONLY (exact file paths, current state, relevant code, conventions, active branch, gotchas) — NEVER modify, create, or delete files; (3) rewrite the instruction into ONE clear, self-contained prompt that the orchestrator can execute autonomously, preserving the user\'s original intent without inventing scope. Then deliver it: write ONE message JSON into your outbox with "to":"god", "act":"request", a short subject, and the finished prompt as the body. Do NOT perform the task yourself — your only output is the improved prompt sent to the orchestrator.'
      : 'For anything ambiguous, cross-cutting, or needing sign-off, address a message to "god".';
    const guardrailsLine = 'Guardrails: a circuit breaker watches the team — a "Circuit breaker: steer/constrain" message means you are looping or overspending, so STOP repeating, summarize what you tried, and follow it. Be token-frugal (a team-wide or per-agent token budget can pause you). The shared plan has two parts: board.md (freeform; god is the sole scribe) and tasks.json (structured kanban — todo/doing/blocked/done).';
    const base = [
      `You are "${meta.name}" (${meta.id}), an autonomous agent in a collaborating hive of Claude agents.`,
      `Your private workspace is ${dir}. The shared hive is ${root}. Full protocol: ${root}/PROTOCOL.md.`,
      '',
      'HIVE PROTOCOL — follow it every task:',
      `1. At the START of a task, read ${dir}/memory.md and EVERY file in ${dir}/inbox/ (messages other agents sent you). After handling an inbox message, move its file into ${dir}/inbox/.done/.`,
      `2. Record durable facts, decisions, and context by appending to ${dir}/memory.md.`,
      `3. To ask another agent for something or share information, write ONE message JSON into ${dir}/outbox/ (schema in PROTOCOL.md). NEVER write into another agent's folder — the orchestrator delivers your outbox.`,
      '4. At the END of a task, append what you learned to memory.md so future-you remembers.',
      guardrailsLine,
      memoryLine,
      godLine,
      `Env vars available to you: AGENT_ID, AGENT_NAME, HIVE_ROOT, AGENT_DIR.`
    ].filter(Boolean).join('\n');
    // Operator addendum goes LAST, after the volatile-free assembled lines. It is
    // stable for an agent's lifetime (only changes on an explicit dashboard edit
    // + respawn), so it does not violate the prompt-cache invariant above.
    const custom = typeof meta.customPrompt === 'string' ? meta.customPrompt.trim() : '';
    if (custom) {
      return base + '\n\nOPERATOR INSTRUCTIONS (added via the dashboard — follow these):\n' + meta.customPrompt;
    }
    return base;
  }

  // — operator prompt + metadata (dashboard-editable) —

  /**
   * The agent's composed system prompt split for the dashboard editor:
   *  - base   = the FULL assembled system prompt EXCLUDING the operator block
   *             (computed via the real injectedPrompt with customPrompt forced
   *             to '' — so the UI shows EXACTLY what would be injected sans
   *             addendum). Read-only in the UI.
   *  - custom = the persisted operator addendum ('' if none).
   * Returns empty strings when the hive is disabled or the agent is unknown.
   */
  getAgentPrompt(id: string): { base: string; custom: string } {
    const root = this.root();
    if (!root) return { base: '', custom: '' };
    const meta = this.registry().agents[id];
    if (!meta) return { base: '', custom: '' };
    const semanticMemory = !!this._semanticMemory;
    // Compute base off a meta clone with the addendum stripped, reusing the REAL
    // builder so base never drifts from what's actually injected.
    const base = this.injectedPrompt(
      { ...meta, customPrompt: '' },
      this.agentDir(id),
      root,
      semanticMemory
    );
    return { base, custom: meta.customPrompt ?? '' };
  }

  /** Persist the operator's prompt addendum onto the agent's registry entry and
   *  commit. Applied on the agent's next (re)spawn via injectedPrompt. */
  setAgentPrompt(id: string, custom: string): { ok: boolean; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: 'hive disabled (no harnessHome)' };
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: `unknown agent: ${id}` };
      agent.customPrompt = typeof custom === 'string' ? custom : '';
      agent.lastSeen = Date.now();
      this.atomicWriteJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'prompt', agentId: id });
      this.commit(`hive: prompt ${id}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Merge editable per-agent metadata (name/role/capabilities) into the registry
   *  entry and commit. Live where the field is read live (registry); name/role
   *  take effect immediately, the prompt-baked identity refreshes on respawn. */
  updateAgentMeta(
    id: string,
    patch: { name?: string; role?: string; capabilities?: string[] }
  ): { ok: boolean; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: 'hive disabled (no harnessHome)' };
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: `unknown agent: ${id}` };
      if (typeof patch?.name === 'string' && patch.name.trim()) agent.name = patch.name;
      if (typeof patch?.role === 'string') agent.role = patch.role;
      if (Array.isArray(patch?.capabilities)) {
        agent.capabilities = patch.capabilities.filter((c): c is string => typeof c === 'string');
      }
      agent.lastSeen = Date.now();
      this.atomicWriteJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'meta', agentId: id });
      this.commit(`hive: meta ${id}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // — messaging —

  /** Normalize a partial message into a full HiveMessage. */
  private normalize(partial: Partial<HiveMessage>, from: string): HiveMessage {
    const act = (partial.act ?? 'inform') as MessageAct;
    return {
      id: partial.id ?? `${stamp()}-${shortRand()}`,
      conversation: partial.conversation ?? `conv-${shortRand()}`,
      in_reply_to: partial.in_reply_to ?? null,
      from: partial.from ?? from,
      to: partial.to ?? 'god',
      act,
      subject: partial.subject ?? '',
      body: partial.body ?? '',
      hops: typeof partial.hops === 'number' ? partial.hops : 0,
      requires_reply: partial.requires_reply ?? ['request', 'query', 'propose'].includes(act),
      needs_human: partial.needs_human ?? false,
      created_at: partial.created_at ?? new Date().toISOString()
    };
  }

  /** Atomically deliver a message into a recipient agent's inbox. */
  private deliver(msg: HiveMessage, toId: string): void {
    const inbox = join(this.agentDir(toId), 'inbox');
    if (!existsSync(inbox)) return; // unknown recipient — dropped (logged by caller)
    this.atomicWriteJson(join(inbox, `${msg.id}.json`), msg);
  }

  /** Inject a message directly (used by the orchestrator / UI / tests). */
  send(partial: Partial<HiveMessage>, from = 'system'): HiveMessage {
    const msg = this.normalize(partial, from);
    this.routeMessage(msg);
    this.commit(`hive: msg ${msg.from}→${msg.to} (${msg.act})`);
    return msg;
  }

  private routeMessage(msg: HiveMessage): void {
    if (msg.hops > HOP_CAP) {
      // loop guard — drop a runaway message rather than let agents ping-pong.
      // There's no human queue to fall back on; the god agent owns conflicts.
      this.appendLog({ kind: 'drop', reason: 'hop-cap', from: msg.from, to: msg.to, id: msg.id });
      return;
    }
    const reg = this.registry();
    const godId = reg.godId ?? 'god';
    // The hive has no separate human-approval queue — approvals are native to
    // each agent's Claude Code session (and approvable remotely). A message aimed
    // at "human" is handled by the god/orchestrator, the human's proxy here.
    const resolveTo = (to: string): string => (to === 'human' || to === 'god' ? godId : to);
    const targets = msg.to === 'broadcast'
      // The roster for fan-out is the ACTIVE registry: skip the send-only prep
      // assistant, any archived agent (closed tab), and providers that can't
      // drain an inbox (hookless custom commands) so mail never piles into a dead
      // inbox no one reads. Claude, Codex AND Antigravity workers ARE included —
      // each can drain its inbox: Claude via its Stop hook, Antigravity via the
      // agy-hook Stop→drain bridge, Codex via the renderer's idle inbox-wake nudge.
      ? Object.keys(reg.agents).filter((a) =>
          a !== msg.from
          && !reg.agents[a]?.isAssistant
          && !reg.agents[a]?.archived
          && canReceiveInbox(reg.agents[a]?.provider))
      // Never deliver to self — guards a god → "human" message looping back to god.
      : [resolveTo(msg.to)].filter((t) => t !== msg.from);
    for (const t of targets) {
      // The send-only prep assistant must never be a delivery target: it doesn't
      // drain an inbox, so direct mail to it would rot unread (observed live: a
      // task brief plus the follow-up reprimand about the unread inbox, both
      // unread for hours). Bounce such mail to god instead, so the sender's intent
      // surfaces immediately and nothing is silently lost.
      if (reg.agents[t]?.isAssistant) {
        this.deliver({
          ...msg,
          to: godId,
          subject: `[bounced — "${t}" is the send-only prep assistant; route work to a real agent] ${msg.subject}`
        }, godId);
        continue;
      }
      // A provider that can't drain its own inbox (a hookless custom command)
      // would let direct mail rot unread. Claude (Stop hook), Antigravity
      // (agy-hook Stop→drain bridge) and Codex (renderer idle inbox-wake nudge)
      // all drain their inbox, so they receive directly into their inbox/. For a
      // provider that can't, try a terminal work-order handoff to its REPL (#53);
      // if the renderer is unavailable, bounce to god to relay. God is exempt
      // (the bounce target).
      if (t !== godId && !canReceiveInbox(reg.agents[t]?.provider)) {
        if (!this.emitTerminalHandoff(msg, t)) {
          this.deliver({
            ...msg,
            to: godId,
            subject: `[undeliverable — "${t}" runs ${reg.agents[t]?.provider ?? 'a hookless CLI'} and the terminal handoff failed (renderer unavailable); relay this to it] ${msg.subject}`
          }, godId);
        }
        continue;
      }
      this.deliver(msg, t);
    }
    this.appendLog({ kind: 'message', from: msg.from, to: msg.to, act: msg.act, subject: msg.subject, id: msg.id });
    this.emitMessage(msg, targets);
    // Main-process observer (e.g. the closing-time controller watching for the
    // team's ACKs and the god's COMPLETE). Best-effort, never breaks routing.
    try { this.routedObserver?.(msg, targets); } catch { /* observer error */ }
  }

  /** Observer invoked for EVERY routed message with its resolved targets.
   *  Used by main-process features that react to hive traffic (closing time). */
  private routedObserver: ((msg: HiveMessage, targets: string[]) => void) | null = null;
  setRoutedObserver(cb: ((msg: HiveMessage, targets: string[]) => void) | null): void {
    this.routedObserver = cb;
  }

  /** Tell the renderer a message was routed, with its resolved recipients, so
   *  the dashboard can reflect the handoff from the sender to each one.
   *  Best-effort. */
  private emitMessage(msg: HiveMessage, targets: string[]): void {
    this.emit?.('hive:message', {
      id: msg.id,
      from: msg.from,
      to: msg.to,
      act: msg.act,
      subject: msg.subject,
      targets,
      // Flags a message the agent routed to the human (now handled by the god
      // proxy) so the dashboard can highlight it. Cosmetic only — no queue behind it.
      needsHuman: msg.to === 'human'
    });
  }

  /** Non-Claude providers cannot drain hive inbox; hand direct mail to the
   *  renderer so it can queue a terminal work order for the target PTY. */
  private emitTerminalHandoff(msg: HiveMessage, targetId: string): boolean {
    const delivered = this.emit?.('hive:terminalHandoff', {
      id: msg.id,
      from: msg.from,
      to: targetId,
      act: msg.act,
      subject: msg.subject,
      body: msg.body,
      requiresReply: msg.requires_reply,
      createdAt: msg.created_at
    }) === true;
    this.appendLog({
      kind: 'terminal-handoff',
      from: msg.from,
      to: targetId,
      act: msg.act,
      subject: msg.subject,
      id: msg.id,
      delivered
    });
    return delivered;
  }

  // — router: drain outboxes → inboxes —

  /** Poll-based router. Cheap and robust vs fs.watch quirks on macOS. */
  startRouter(intervalMs = 1500): void {
    if (this.routerTimer || !this.enabled()) return;
    this.routerTimer = setInterval(() => {
      try { this.routeOnce(); } catch { /* keep the loop alive */ }
    }, intervalMs);
  }
  stopRouter(): void {
    if (this.routerTimer) { clearInterval(this.routerTimer); this.routerTimer = null; }
  }

  routeOnce(): number {
    const root = this.root();
    if (!root) return 0;
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return 0;
    let routed = 0;
    for (const id of readdirSync(agentsDir)) {
      const outbox = join(agentsDir, id, 'outbox');
      if (!existsSync(outbox)) continue;
      for (const f of readdirSync(outbox)) {
        if (!f.endsWith('.json')) continue;
        const full = join(outbox, f);
        try {
          const partial = JSON.parse(readFileSync(full, 'utf8')) as Partial<HiveMessage>;
          const msg = this.normalize(partial, id);
          msg.from = id; // sender is authoritative — the owning directory
          this.routeMessage(msg);
          renameSync(full, join(outbox, '.sent', f)); // archive, don't reprocess
          routed++;
        } catch {
          // malformed file — quarantine so we don't spin on it
          try { renameSync(full, join(outbox, '.sent', `bad-${f}`)); } catch { /* noop */ }
        }
      }
    }
    if (routed > 0) this.commit(`hive: routed ${routed} message(s)`);
    return routed;
  }

  // — read helpers (for IPC / UI) —

  registry(): Registry {
    const root = this.root();
    if (!root) return { godId: null, agents: {} };
    return this.readJson<Registry>(join(root, 'registry.json'), { godId: null, agents: {} });
  }
  board(): string {
    const root = this.root();
    return root && existsSync(join(root, 'board.md')) ? readFileSync(join(root, 'board.md'), 'utf8') : '';
  }

  /**
   * Overwrite the shared blackboard from the dashboard (the Notepad's Scratchpad).
   * Writes board.md atomically, then bumps the LAST-WRITER-WINS stamps in registry
   * meta (boardUpdatedAt + boardHash) so the next sync beat detects the change and
   * pushes it (readStateRows reads these stamps). Commits via the single-committer
   * path. Best-effort — returns {ok:false} when the hive is disabled or a write
   * fails, so the IPC layer never throws.
   */
  setBoard(body: string): { ok: boolean; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: 'hive disabled (no harnessHome)' };
    try {
      this.ensureHive();
      const path = join(root, 'board.md');
      // board.md is raw markdown — write atomically via tmp+rename (atomicWriteJson
      // is JSON-only) so a reader never sees a torn file.
      const tmp = `${path}.tmp-${shortRand()}`;
      writeFileSync(tmp, body, 'utf8');
      renameSync(tmp, path);
      // Bump the LWW stamps so the next push beat sees a changed board.
      const reg = this.registry();
      const hash = createHash('sha1').update(body).digest('hex');
      reg.meta = { ...(reg.meta ?? {}), boardUpdatedAt: Date.now(), boardHash: hash };
      this.atomicWriteJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'board', bytes: body.length });
      this.commit('hive: board (dashboard)');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** The orchestrator's "team pulse" snippet (<hive>/pulse.md), the short status
   *  pushed to member_notes each beat so teammates see what this user is up to.
   *  '' when the hive is disabled or the file is missing. */
  pulse(): string {
    const root = this.root();
    return root && existsSync(join(root, 'pulse.md')) ? readFileSync(join(root, 'pulse.md'), 'utf8') : '';
  }

  /** Overwrite pulse.md from the dashboard (the Notepad's Team Pulse editor).
   *  Atomic tmp+rename so a reader never sees a torn file; committed via the
   *  single-committer path. The next sync beat pushes the new body to
   *  member_notes. Best-effort — never throws into the IPC layer. */
  setPulse(body: string): { ok: boolean; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: 'hive disabled (no harnessHome)' };
    try {
      this.ensureHive();
      const path = join(root, 'pulse.md');
      const tmp = `${path}.tmp-${shortRand()}`;
      writeFileSync(tmp, body, 'utf8');
      renameSync(tmp, path);
      this.appendLog({ kind: 'pulse', bytes: body.length });
      this.commit('hive: pulse');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  tasks(): unknown {
    const root = this.root();
    return root ? this.readJson(join(root, 'tasks.json'), { tasks: [] }) : { tasks: [] };
  }

  /** Persist the task ledger to hive/tasks.json and commit it. Mirrors the
   *  board/message persist pattern: write JSON, log the change, single-commit.
   *
   *  Stamps each card's `updatedAt` (ms epoch) for Phase 3 LAST-WRITER-WINS sync:
   *  ADDITIVE and minimal — a card is (re)stamped ONLY when its content actually
   *  changed vs the prior on-disk version (or it had no stamp at all), so a write
   *  that touches one card doesn't bump every card's stamp and lose remote edits.
   *  Old cards without a stamp default to 0 (always lose to a stamped remote). */
  writeTasks(tasks: HiveTask[]): void {
    const root = this.root();
    if (!root) return;
    this.ensureHive();
    this.writeJson(join(root, 'tasks.json'), { tasks: this.stampTasks(tasks) });
    this.appendLog({ kind: 'tasks', count: tasks.length });
    this.commit(`hive: tasks (${tasks.length})`);
  }

  /** Content fingerprint of a task EXCLUDING its sync stamps, so re-stamping is
   *  driven purely by real edits (not by the stamp itself changing). */
  private taskContentHash(t: HiveTask): string {
    const { updatedAt: _u, updatedBy: _b, ...content } = t;
    void _u; void _b;
    return createHash('sha1').update(JSON.stringify(content)).digest('hex');
  }

  /** Stamp `updatedAt` on cards whose content changed vs the current on-disk
   *  ledger (or that carry no stamp yet); leave unchanged cards' stamps intact.
   *  Pure (returns a new array) — never mutates the caller's objects. */
  private stampTasks(next: HiveTask[]): HiveTask[] {
    const now = Date.now();
    const prev = (this.tasks() as { tasks?: HiveTask[] }).tasks ?? [];
    const prevById = new Map<string, HiveTask>();
    for (const t of prev) if (t && typeof t.id === 'string') prevById.set(t.id, t);
    return next.map((t) => {
      const before = prevById.get(t.id);
      const unchanged =
        before &&
        typeof t.updatedAt === 'number' &&
        this.taskContentHash(before) === this.taskContentHash(t);
      if (unchanged) return t; // real content identical → keep its existing stamp
      return { ...t, updatedAt: now };
    });
  }
  // — Phase 3 shared-state sync (HiveBridge implementation) —
  //
  // The DECOUPLING CONTRACT: sync/state.ts is PURE TRANSPORT and never imports
  // hive.ts. All hive<->DB shape mapping + the LAST-WRITER-WINS / ADDITIVE merge
  // live here, behind the two methods index.ts wires into the SyncManager as a
  // `HiveBridge`. readStateRows() returns DOMAIN fields only (snake_case, DB-
  // column-ready); state.ts stamps workspace_id/machine_id before upserting.

  /**
   * Shape the hive's shared state — roster (registry.json), kanban (tasks.json),
   * and blackboard (board.md) — into DB-column-ready domain rows for the push.
   *
   * Each row carries an `updated_at` (ms epoch) — the LAST-WRITER-WINS key:
   *  - agents: `last_seen` doubles as `updated_at` (the only per-agent write stamp
   *    we have); a never-seen agent defaults to 0.
   *  - tasks:  the per-card `updatedAt` stamped by `writeTasks` (default 0 for old
   *    cards); the whole card rides along as the jsonb `payload`.
   *  - board:  a content-derived stamp tracked in registry `meta` — the harness has
   *    no board writer (god agents edit board.md directly), so we detect a body
   *    change by hash and bump `meta.boardUpdatedAt`, persisting it so subsequent
   *    pushes are stable until the body changes again. Defaults to 0.
   *
   * Read-only w.r.t. the on-disk shapes EXCEPT the board-stamp bookkeeping, which
   * is ADDITIVE (only touches registry `meta`). Best-effort; never throws.
   */
  readStateRows(): StateRows {
    const empty: StateRows = { agents: [], tasks: [], board: null };
    const root = this.root();
    if (!root) return empty;
    try {
      const reg = this.registry();
      const agents: Record<string, unknown>[] = Object.entries(reg.agents ?? {}).map(
        ([id, a]) => ({
          agent_id: id,
          name: a.name ?? id,
          role: a.role ?? null,
          status: a.status ?? null,
          cwd: a.cwd ?? null,
          is_god: reg.godId === id || !!a.isGod,
          archived: !!a.archived,
          last_seen: typeof a.lastSeen === 'number' ? a.lastSeen : 0,
          // last_seen IS the per-agent write stamp — reuse it as the LWW key.
          updated_at: typeof a.lastSeen === 'number' ? a.lastSeen : 0
        })
      );

      const taskList = (this.tasks() as { tasks?: HiveTask[] }).tasks ?? [];
      const tasks: Record<string, unknown>[] = taskList
        .filter((t): t is HiveTask => !!t && typeof t.id === 'string')
        .map((t) => ({
          task_id: t.id,
          payload: t, // whole card as jsonb
          status: t.status ?? null,
          assignee: t.assignee ?? null,
          updated_by: t.updatedBy ?? null,
          updated_at: typeof t.updatedAt === 'number' ? t.updatedAt : 0
        }));

      const board = this.boardStateRow(root, reg);

      return { agents, tasks, board };
    } catch {
      return empty;
    }
  }

  /**
   * Compute the board's { body, updated_at } row, tracking its write stamp in
   * registry `meta` by content hash. ADDITIVE: only ever touches `meta`. On the
   * first read of an existing board it stamps `now` once (so it can sync), then
   * keeps that stamp until the body changes. Returns null when there's no board.
   */
  private boardStateRow(root: string, reg: Registry): { body: string; updated_at: number } | null {
    const path = join(root, 'board.md');
    if (!existsSync(path)) return null;
    let body: string;
    try { body = readFileSync(path, 'utf8'); } catch { return null; }
    const hash = createHash('sha1').update(body).digest('hex');
    const meta = reg.meta ?? {};
    let stamp = typeof meta.boardUpdatedAt === 'number' ? meta.boardUpdatedAt : 0;
    if (meta.boardHash !== hash) {
      // Body changed since last stamp (or never stamped) — bump + persist so the
      // stamp is stable across pushes until the next real edit. Best-effort.
      stamp = Date.now();
      try {
        reg.meta = { ...meta, boardUpdatedAt: stamp, boardHash: hash };
        this.writeJson(join(root, 'registry.json'), reg);
        this.commit('hive: board sync stamp');
      } catch { /* best-effort — stamp still returned for this pass */ }
    }
    return { body, updated_at: stamp };
  }

  /**
   * Merge remote shared-state rows into the local hive — LAST-WRITER-WINS by
   * `updated_at` and ADDITIVE (never deletes a local row missing from remote).
   *
   *  - agents/tasks: for each remote row, upsert into the local map ONLY when there
   *    is no local row with that id OR `remote.updated_at` is STRICTLY newer than
   *    the local row's stamp. Local-only rows are preserved untouched. `godId` and
   *    any local-only registry/card fields survive.
   *  - board: overwrite board.md ONLY when `remote.updated_at` is strictly newer
   *    than the local board stamp; the new stamp/hash is recorded in registry meta.
   *
   * After each CHANGED file: atomicWriteJson then commit() (the single-committer
   * path). Best-effort throughout — never throws into the sync timer.
   */
  applyStateRows(remote: {
    agents?: Record<string, unknown>[];
    tasks?: Record<string, unknown>[];
    board?: { body: string; updated_at: number } | null;
  }): void {
    const root = this.root();
    if (!root) return;
    try { this.ensureHive(); } catch { return; }

    // Roster (agents) + kanban (tasks) are PER-OWNER and intentionally NOT merged:
    // a teammate's agents/tasks would pollute this hive's registry/tasks and make
    // the local orchestrator try to manage agents it can't reach. Each machine keeps
    // its own roster + kanban; teammates' are viewed on demand from Supabase. Only
    // the BLACKBOARD is shared (merged below), so `remote.agents`/`remote.tasks` are
    // ignored here.
    try {
      if (remote.board) this.mergeBoard(root, remote.board);
    } catch { /* best-effort per file */ }
  }

  /** LWW overwrite of board.md — only when the remote stamp is strictly newer
   *  than the local board stamp. Records the new stamp/hash in registry meta. */
  private mergeBoard(root: string, remote: { body: string; updated_at: number }): void {
    if (typeof remote.body !== 'string' || typeof remote.updated_at !== 'number') return;
    const reg = this.registry();
    const localAt = typeof reg.meta?.boardUpdatedAt === 'number' ? reg.meta.boardUpdatedAt : 0;
    if (remote.updated_at <= localAt) return; // local same-or-newer → keep

    const path = join(root, 'board.md');
    // atomicWriteJson is JSON-only; board.md is raw markdown — write atomically
    // via the same tmp+rename discipline so a reader never sees a torn file.
    const tmp = `${path}.tmp-${shortRand()}`;
    writeFileSync(tmp, remote.body, 'utf8');
    renameSync(tmp, path);

    const hash = createHash('sha1').update(remote.body).digest('hex');
    reg.meta = { ...(reg.meta ?? {}), boardUpdatedAt: remote.updated_at, boardHash: hash };
    this.atomicWriteJson(join(root, 'registry.json'), reg);
    this.appendLog({ kind: 'sync-board', updatedAt: remote.updated_at });
    this.commit('hive: sync board (remote)');
  }

  memory(id: string): string {
    const p = join(this.agentDir(id), 'memory.md');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  }
  inbox(id: string): HiveMessage[] {
    return this.listMessages(join(this.agentDir(id), 'inbox'));
  }
  /** Count undrained inbox messages for an agent (cheap — for the fleet snapshot). */
  inboxBacklog(id: string): number {
    const dir = join(this.agentDir(id), 'inbox');
    if (!existsSync(dir)) return 0;
    try { return readdirSync(dir).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
  }
  /** Install the Antigravity (`agy`) lifecycle-hook bridge: write the normalizer
   *  shim and merge a `munder-hive` hook group into agy's global hooks.json so a
   *  Gemini worker reports PreToolUse/PostToolUse/Stop/PreInvocation/PostInvocation
   *  to this HookServer (live status + inbox-drain), reusing the Claude pipeline.
   *
   *  Two agy-isms handled: (1) antigravity-cli#49 — agy LOADS hooks from
   *  `~/.gemini/antigravity-cli/hooks.json` but TRIGGERS from `~/.gemini/config/
   *  hooks.json`, so we write BOTH; (2) commands go to cmd.exe and agy mangles
   *  embedded quotes, so the shim path must be space-free (hive roots are).
   *  Runtime-scoped by AGENT_ID (the shim no-ops for non-hive agy sessions), so
   *  this global config never disturbs the user's own `agy` usage. Best-effort,
   *  idempotent (only our own group is overwritten). */
  private installAgyHooks(): void {
    const root = this.root();
    if (!root) return;
    const shim = join(root, 'bin', 'agy-hook.cjs');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(shim, AGY_HOOK_SHIM, 'utf8');
    const tool = (event: string) => ({
      matcher: '*',
      hooks: [{ type: 'command', command: `node ${shim} ${event}`, timeout: 0 }]
    });
    const plain = (event: string) => ({
      hooks: [{ type: 'command', command: `node ${shim} ${event}`, timeout: 0 }]
    });
    const group = {
      PreToolUse: [tool('PreToolUse')],
      PostToolUse: [tool('PostToolUse')],
      PreInvocation: [plain('PreInvocation')],
      PostInvocation: [plain('PostInvocation')],
      Stop: [plain('Stop')]
    };
    const gem = join(homedir(), '.gemini');
    for (const p of [join(gem, 'config', 'hooks.json'), join(gem, 'antigravity-cli', 'hooks.json')]) {
      try {
        mkdirSync(dirname(p), { recursive: true });
        let existing: Record<string, unknown> = {};
        if (existsSync(p)) {
          try { existing = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { existing = {}; }
        }
        existing['munder-hive'] = group;
        writeFileSync(p, JSON.stringify(existing, null, 2), 'utf8');
      } catch { /* best-effort per file */ }
    }
  }

  /** Write the live fleet snapshot the orchestrator reads (`fleet.json`, gitignored).
   *  Best-effort — called from a timer, must never throw. */
  writeFleetSnapshot(snapshot: unknown): void {
    const root = this.root();
    if (!root) return;
    try { writeFileSync(join(root, 'fleet.json'), JSON.stringify(snapshot, null, 2), 'utf8'); } catch { /* noop */ }
  }
  logTail(n = 200): unknown[] {
    const root = this.root();
    if (!root || !existsSync(join(root, 'log.jsonl'))) return [];
    const lines = readFileSync(join(root, 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  }

  private listMessages(dir: string): HiveMessage[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) as HiveMessage; } catch { return null; } })
      .filter((m): m is HiveMessage => m !== null);
  }

  // — log —
  appendLog(event: Record<string, unknown>): void {
    const root = this.root();
    if (!root) return;
    const line = JSON.stringify({ ts: Date.now(), ...event }) + '\n';
    try { appendFileSync(join(root, 'log.jsonl'), line, 'utf8'); } catch { /* noop */ }
  }

  /**
   * Append one cost sample to the durable, append-only ledger at
   * `<root>/cost-ledger.jsonl` (Lane A #6.6d). This is the SOLE durable cost
   * store; its row is exactly the shape Kevin (#4) reserves for the cost_ledger
   * SQLite table, so migration is a mechanical INSERT…SELECT.
   *
   * 🔒 PII: persist ONLY the allowlisted AgentUsageSample — NEVER a raw OTel
   * record (those carry user.email / account / org / hashed-user-id). The sample
   * is PII-free by construction upstream (the provider's normalize step), so we
   * add no redaction here; we just must not widen what we write. The file lives
   * at the hive ROOT, so the semantic-memory embedder (which only reads per-agent
   * memory.md) never ingests it — no index noise, no .gitignore entry needed.
   *
   * Like appendLog: append to disk now (durable immediately), let it ride the
   * next natural commit. Best-effort — never throws into the beat.
   */
  appendCostLedger(sample: AgentUsageSample): void {
    const root = this.root();
    if (!root) return;
    // Fully snake_case so the row maps 1:1 onto Kevin's (#4) cost_ledger SQLite
    // columns (agent_id, session_id, ts, input, output, cache_read,
    // cache_creation, model, usd) — migration is a straight INSERT…SELECT.
    const row = {
      agent_id: sample.agentId,
      session_id: sample.sessionId,
      ts: sample.ts,
      input: sample.input,
      output: sample.output,
      cache_read: sample.cacheRead,
      cache_creation: sample.cacheCreation,
      model: sample.model,
      usd: sample.usd
    };
    try { appendFileSync(join(root, 'cost-ledger.jsonl'), JSON.stringify(row) + '\n', 'utf8'); } catch { /* noop */ }
  }

  // — json + atomic io —
  private readJson<T>(p: string, fallback: T): T {
    try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return fallback; }
  }
  private writeJson(p: string, data: unknown): void {
    writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  }
  private atomicWriteJson(p: string, data: unknown): void {
    const tmp = `${p}.tmp-${shortRand()}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, p);
  }

  // — git (single committer, retry + stale-lock recovery) —
  private git(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
    const res = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=Hive', '-c', 'user.email=hive@local', ...args], {
      cwd, encoding: 'utf8', timeout: 8000
    });
    return { ok: res.status === 0, out: res.stdout ?? '', err: res.stderr ?? '' };
  }

  /** Commit all hive changes. No-op if there is nothing staged. */
  commit(message: string): void {
    const root = this.root();
    if (!root || !existsSync(join(root, '.git'))) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      this.clearStaleLock(root);
      const add = this.git(['add', '-A'], root);
      const commit = this.git(['commit', '-q', '-m', message], root);
      if (commit.ok) return;
      if (/nothing to commit/i.test(commit.out + commit.err)) return;
      if (!add.ok || /index\.lock/i.test(commit.err)) { sleepSync(50 * (attempt + 1)); continue; }
      return; // a non-lock failure — give up quietly, the next mutation retries
    }
  }

  private clearStaleLock(root: string): void {
    const lock = join(root, '.git', 'index.lock');
    try {
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock);
    } catch { /* noop */ }
  }
}

// ─── PROTOCOL.md (written into the hive, readable by every agent) ────────────

/** The Claude Code command reference written to <hive>/COMMANDS.md, rendered from
 *  the SAME source as the UI "commands" tab so they never drift. Leads with the
 *  orchestrator note: slash = own session only, cli = shell/fleet; monitor
 *  siblings via fleet.json (claude agents does NOT see them). */
function renderCommandsMd(): string {
  const lines: string[] = [
    '# Claude Code commands',
    '',
    'Reference of the Claude Code commands available to you. Two kinds:',
    '- **slash** commands act ONLY on your own session — you CANNOT run them on another agent\'s terminal.',
    '- **cli** commands run in your shell (Bash) and can target the fleet, spawn, or query.',
    '',
    'To MONITOR the other agents in this hive, read `fleet.json` in the hive root (live per-agent tokens, cost, status, last tool, breaker level, inbox backlog) plus `registry.json` — `claude agents` does NOT list your hive siblings. Use `claude -p "..." --output-format json` for a one-off headless query.',
    '',
    'TEAM PULSE: each standup, keep `pulse.md` in the hive root updated with a 1-3 line status of your user plus the team\'s recent activity — it is the snippet teammates see as your "Team pulse" in the shared Notepad.',
    ''
  ];
  for (const g of COMMAND_GROUPS) {
    lines.push(`## ${g.title}`, '');
    for (const it of g.items) {
      lines.push(`- \`${it.cmd.trim()}\` _(${it.kind})_ — ${it.desc}${it.usage ? ` e.g. \`${it.usage}\`` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
const COMMANDS_MD = renderCommandsMd();

const PROTOCOL_MD = `# Hive protocol

You are one of several Claude agents sharing this hive. Coordination is entirely
file-based; the harness (main process) is the only thing that runs git and the
only thing that moves messages between agents.

## Your workspace — \`agents/<your-id>/\`
- \`identity.md\`  — who you are (read-only; the harness writes it).
- \`memory.md\`    — your long-term memory. Read at the start of a task; append to it as you learn.
- \`inbox/\`       — messages addressed to you. Read them at the start of a task.
- \`inbox/.done/\` — move a message here once you've handled it.
- \`outbox/\`      — drop messages here to send them. The harness delivers them.

**Never write into another agent's folder.** Write to your own \`outbox/\`; the
orchestrator routes it. This keeps every file single-writer.

## Sending a message
Write one JSON file into \`outbox/\` (any filename ending in \`.json\`):

\`\`\`json
{
  "to": "<agent-id> | god | broadcast",
  "act": "request | inform | propose | query | agree | refuse | done",
  "subject": "one-line summary",
  "body": "the details",
  "conversation": "carry this across a thread (optional)",
  "in_reply_to": "<message id you're replying to> (optional)"
}
\`\`\`

The harness fills in \`id\`, \`from\`, \`hops\`, and timestamps.

## Rules of the road
- Only \`request\`, \`query\`, and \`propose\` expect a reply. \`inform\` and \`done\` are terminal —
  don't reply to them, or two agents will loop forever.
- For anything ambiguous, cross-cutting, or needing sign-off, message \`god\` — the
  god agent clarifies answers for you so you rarely need the human directly.
- There is NO separate human-approval queue. Human-in-the-loop is native to Claude
  Code: a tool you run that needs permission prompts in your own session (the human
  can approve it remotely from their phone via \`/remote-control\`). If you genuinely
  need a human decision, raise it with \`god\` (a message \`"to": "human"\` is routed to
  the god/orchestrator, the human's proxy on the team).
- \`board.md\` is the shared plan. Don't edit it directly — \`propose\` changes to \`god\`,
  who is its sole scribe.
- Re-reading a message you already moved to \`.done/\` is a no-op. Don't reprocess.

## The work: board.md vs tasks.json
There are two shared surfaces, both in the hive root:
- \`board.md\` — the freeform narrative plan. The god agent is its sole scribe; others \`propose\` edits.
- \`tasks.json\` — the structured task ledger (a kanban: \`todo / doing / blocked / done\`, with title,
  assignee, priority, deps). Keep the task you're working reflected in its status.

## Guardrails: circuit breaker & token budgets
A circuit breaker watches every agent for runaway behavior (looping on the same tool, error storms,
overspending). It escalates gently: \`steer\` → \`constrain\` → \`stop\`. If a \`Circuit breaker: steer\`
or \`Circuit breaker: constrain\` message lands in your inbox, you ARE the problem it caught — stop
repeating, summarize what you've tried, and do exactly what the message says (constrain = go read-only
and get god's sign-off before more tool calls). Be **token-frugal**: the team has a token budget and
each agent can have its own token limit; crossing it trips the breaker. Prefer references over pasted
content, and \`/compact\` your own session when context gets heavy.

## Fleet monitoring (orchestrator)
You (god) are responsible for situational awareness. To see the live state of every agent, read
\`fleet.json\` in the hive root — it is refreshed continuously with each agent's tokens, cost, status,
breaker level, last tool, last-active time, and inbox backlog. Pair it with \`registry.json\` (the roster)
and \`log.jsonl\` (the event feed). IMPORTANT: \`claude agents\` will NOT show your hive's sibling
sessions (they're spawned independently) — \`fleet.json\` is your source of truth for them. For a deeper
look at one agent, read its \`agents/<id>/memory.md\` and \`inbox/\`, or send it a \`query\`. A full
Claude Code command reference (slash = your own session only; CLI = your shell, can target the fleet)
is in \`COMMANDS.md\` in the hive root.

## Shared semantic memory
Durable facts you append to your \`memory.md\` are automatically embedded into a
team-wide semantic memory — shared across every teammate, session, and project in
the workspace. Embedding runs LOCALLY via Ollama (\`nomic-embed-text\`); nothing
leaves the machine, and the vectors live in the team's shared store. You don't run
any command for this: just keep writing durable facts to \`memory.md\` and they
become recallable by meaning for the whole hive. The human searches this memory
from the Hive dashboard. This is the living/breathing knowledge layer — the more
the team records, the better future sessions get.
`;

// ─── cth-hook shim (written to <hive>/bin/cth-hook.cjs) ──────────────────────
// A minimal pipe: read the hook payload on stdin, tag it with this agent's id,
// forward it to the hive's UDS, and relay the response back to `claude`. All the
// real logic lives in the main process (HookServer). Never blocks a stop on error.
const HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const isStatus = process.argv.includes('--status');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(data || '{}'); } catch (_) {}
  if (!payload.agent_id) payload.agent_id = process.env.AGENT_ID || null;
  const sock = process.env.HIVE_SOCK;
  if (isStatus) {
    // Status-line mode: Claude Code pipes the session status JSON (incl.
    // context_window.total_input_tokens / .context_window_size) after every
    // response. Print the in-terminal gauge IMMEDIATELY (the TUI is waiting),
    // then forward the payload to the harness fire-and-forget so the agent
    // card's context gauge updates push-based, with the EXACT window size.
    payload.hook_event_name = 'Status';
    const cw = payload.context_window || {};
    const used = cw.total_input_tokens, size = cw.context_window_size;
    if (typeof used === 'number' && typeof size === 'number' && size > 0) {
      const pct = Math.round((used / size) * 100);
      process.stdout.write('ctx ' + Math.round(used / 1000) + 'k/' + Math.round(size / 1000) + 'k (' + pct + '%)');
    }
    if (sock) {
      try {
        const c = net.createConnection(sock, () => { c.end(JSON.stringify(payload) + '\\n'); });
        c.on('error', () => {});
        c.on('close', () => process.exit(0));
      } catch (_) { process.exit(0); }
    } else {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 1500).unref();
    return;
  }
  if (!sock) { process.exit(0); }
  let resp = '';
  const done = (code) => { if (resp) process.stdout.write(resp); process.exit(code); };
  const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
  c.setEncoding('utf8');
  c.on('data', (d) => { resp += d; });
  c.on('end', () => done(0));
  c.on('error', () => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
`;

// ─── agy-hook shim (written to <hive>/bin/agy-hook.cjs) ──────────────────────
// Antigravity's `agy` CLI fires lifecycle hooks (PreToolUse/PostToolUse/Stop/
// PreInvocation/PostInvocation) but with a DIFFERENT stdin shape than Claude
// (conversationId / toolCall{name,args} / workspacePaths, and no hook_event_name
// — the event arrives as argv from the hooks.json command). This shim normalizes
// that into the same HookPayload the HookServer already consumes, so status,
// inbox-drain-on-Stop, and tool gating are reused UNCHANGED, then translates the
// server's Claude-shaped response back into agy's stdout contract (decision:
// allow|deny|block + a message). Scoped by AGENT_ID: a personal agy session
// (no AGENT_ID in env) is a no-op, so the global hooks.json never disturbs the
// user's own agy usage — only hive workers (spawned with AGENT_ID set) bridge.
// NOTE (agy bug, antigravity-cli#49): the loader reads ~/.gemini/antigravity-cli/
// hooks.json but the trigger reads ~/.gemini/config/hooks.json — we write BOTH.
const AGY_HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const event = process.argv[2] || 'Unknown';
const agentId = process.env.AGENT_ID || null;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const sock = process.env.HIVE_SOCK;
  if (!agentId || !sock) { process.exit(0); } // not a hive worker → ignore
  let agy = {};
  try { agy = JSON.parse(data || '{}'); } catch (_) {}
  const tc = agy.toolCall || {};
  const payload = {
    hook_event_name: event,
    agent_id: agentId,
    session_id: agy.conversationId,
    transcript_path: agy.transcriptPath,
    cwd: Array.isArray(agy.workspacePaths) ? agy.workspacePaths[0] : undefined,
    tool_name: tc.name,
    tool_input: tc.args
  };
  let resp = '';
  const done = () => {
    // Translate the HookServer's Claude-shaped reply into agy's contract. CRITICAL:
    // agy treats ANY object written to stdout as a decision and FAIL-CLOSES (an
    // empty/decision-less object = DENY). So emit JSON ONLY when there's a real
    // directive (deny/block/steer); otherwise write NOTHING — no output = allow.
    let out = null;
    try {
      const r = JSON.parse(resp || '{}');
      if (r.decision === 'block') out = { decision: 'block', reason: r.reason, stopReason: r.reason, systemMessage: r.reason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny') out = { decision: 'deny', reason: r.hookSpecificOutput.permissionDecisionReason };
      else if (r.continue === false) out = { decision: 'block', stopReason: r.stopReason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) out = { systemMessage: r.hookSpecificOutput.additionalContext };
    } catch (_) {}
    if (out) { try { process.stdout.write(JSON.stringify(out)); } catch (_) {} }
    process.exit(0);
  };
  try {
    const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', done);
    c.on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  } catch (_) { process.exit(0); }
});
`;
