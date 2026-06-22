import { Notification } from 'electron';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HiveManager, type HiveMessage } from './hive';
import { HookServer } from './hooks';
import { CircuitBreaker, type BreakerInput } from './breaker';
import { TelemetryCollector } from './telemetry';
import { ControlRegistry } from './control';
import { MemoryReflector, type ReflectSettings } from './reflect';
import { ThoughtsService } from './thoughts';
import { SyncManager } from './sync';
import { embed as ollamaEmbed } from './memory/ollama';
import type { MemorySettings } from './memory';
import type { PtyManager } from './pty';
import type { PersistStore } from './db';
import {
  readConfig, setTeamMissions,
  teamHome, teamMissions, teamSyncWorkspaceId, teamCostCapTokens, teamAgentTokenCaps,
  ensureDefaultMissions, DEFAULT_TEAM_ID,
  type ScheduledMission
} from './config';

/** Globals the runtime borrows but does NOT own — there is exactly one of each
 *  across the whole app, shared by every team. (The PTY manager, the PTY→agent
 *  map, the SQLite store, the renderer window, the global Ollama memory env.) */
/** Owner of a live PTY: which team it belongs to and which agent it runs (BE-6).
 *  Keyed by the globally-unique PTY id, so a closed tab / breaker-stop archives
 *  on the correct team's hive. */
export interface PtyOwner {
  teamId: string;
  agentId: string;
}

export interface TeamRuntimeDeps {
  /** The live renderer webContents, or null while the window is gone. */
  liveWebContents: () => Electron.WebContents | null;
  /** The single PTY manager (one per app — terminals are global). */
  ptyManager: PtyManager;
  /** Global PTY id → {teamId, agentId}. Shared across teams; ptyForAgent filters
   *  to this team's entries. */
  ptyToAgent: Map<string, PtyOwner>;
  /** Archive + worktree-cleanup for a PTY id (lives in index.ts; global). */
  teardownPty: (ptyId: string) => void;
  /** The shared SQLite store (window bounds + command history). */
  persist: PersistStore;
  /** The global semantic-memory env (Ollama host/model), injected at memory push. */
  memoryEnv: () => Record<string, string>;
  /** Forward every routed hive message to the closing-time coordinator, tagged
   *  with this team's id, so it can collect ACKs per team (BE-8). Optional. */
  onRouted?: (teamId: string, msg: HiveMessage, targets: string[]) => void;
}

/** A mission's live scheduler handles (initial setTimeout + steady setInterval). */
interface MissionTimer {
  timeout?: NodeJS.Timeout;
  interval?: NodeJS.Timeout;
}

/**
 * One team's full service set + lifecycle, bundled so N teams can run in
 * parallel with no cross-team collisions. Everything that used to be a
 * module-level singleton in index.ts — the HiveManager, hook server, telemetry
 * collector, circuit breaker, control registry, memory reflector, thoughts
 * service, sync manager, the mission scheduler, and the always-on fleet/breaker
 * beats — lives here, one instance per team.
 *
 * The collision fix (design §7.5): `breaker`, `control`, and the hook server's
 * `transcriptPaths` all key by agent id, so two teams that both have a `god`/
 * `backend` would corrupt each other's pause/steer/breaker/transcript state.
 * Per-team instances make that impossible without widening any key.
 *
 * NO-MOVE storage (god's locked decision): the default team's `getHome` resolves
 * to `harnessHome` (root stays `<harnessHome>/hive`); cloned teams get
 * `<harnessHome>/teams/<id>`. Because the HiveManager + reflector + thoughts +
 * sync all derive their root as `join(home, 'hive')`, feeding them this one
 * team-scoped home callback makes every read/write team-correct for free.
 */
export class TeamRuntime {
  readonly teamId: string;
  /** True for the legacy/original team (home = harnessHome, root unchanged). */
  readonly isDefault: boolean;

  readonly hive: HiveManager;
  readonly hookServer: HookServer;
  readonly telemetry: TelemetryCollector;
  readonly breaker: CircuitBreaker;
  readonly control: ControlRegistry;
  readonly reflector: MemoryReflector;
  readonly thoughts: ThoughtsService;
  readonly syncManager: SyncManager;
  /** Telemetry IS the usage provider (Seam 1) — the breaker + fleet snapshot pull
   *  through it. Same object, named for the seam it satisfies. */
  readonly usageProvider: TelemetryCollector;

  /** Active mission scheduler timers, keyed by mission id (this team's only). */
  private readonly missionTimers = new Map<string, MissionTimer>();
  /** Always-on beats (independent of the optional heartbeat mission). */
  private fleetTimer: ReturnType<typeof setInterval> | null = null;
  private breakerBeatTimer: ReturnType<typeof setInterval> | null = null;
  /** True once start() has run (services live); false after stop(). Surfaced as
   *  TeamSummary.running so the renderer can badge dormant vs live teams. */
  private started = false;

  /** Whether this team's services are currently running. */
  isRunning(): boolean { return this.started; }

  /** Count of non-archived agents in this team's roster (TeamSummary.agentCount). */
  agentCount(): number {
    return Object.values(this.hive.registry().agents).filter((a) => !a.archived).length;
  }

  constructor(
    teamId: string,
    private deps: TeamRuntimeDeps
  ) {
    this.teamId = teamId;
    this.isDefault = teamId === DEFAULT_TEAM_ID;

    // Team-scoped home callback — the single leverage point. Resolved live so the
    // hive follows a config:changeHome (which moves the base for all teams).
    const getHome = (): string | null => {
      const home = readConfig().harnessHome;
      return home ? teamHome(home, teamId) : null;
    };

    // HiveManager — emit routes through this.emit so every payload carries teamId
    // (§6.3), letting the renderer demux concurrent team streams.
    this.hive = new HiveManager(getHome, (ch, p) => this.emit(ch, p), teamId);

    this.control = new ControlRegistry();

    this.telemetry = new TelemetryCollector({
      emit: (ch, p) => this.emit(ch, p),
      resolveCwd: (agentId) => {
        const agent = this.hive.registry().agents[agentId];
        if (!agent) return null;
        const root = this.hive.root();
        // Workers share this team's auth home (<root>/.agenthome), so their
        // transcripts land under <root>/.agenthome/projects; the god uses ~/.claude.
        const claudeHome = !agent.isGod && root
          ? join(root, '.agenthome')
          : undefined;
        return { cwd: agent.cwd, claudeHome };
      }
    });
    this.usageProvider = this.telemetry;

    // Circuit breaker — POLICY only; the beat feeds it signals + enforces. Config
    // read live so a Settings change applies next beat. Caps are per-team with a
    // global fallback (the default team reads the legacy global values).
    this.breaker = new CircuitBreaker(() => {
      const c = readConfig();
      return {
        ...(c.circuitBreaker ?? {}),
        costCapUsd: c.costCapUsd,
        costCapTokens: teamCostCapTokens(teamId, c),
        agentTokenCaps: teamAgentTokenCaps(teamId, c)
      };
    });
    // Feed the api_error-storm trip from telemetry's OTel api_error spans.
    this.telemetry.onApiError((agentId) => this.breaker.recordError(agentId));

    this.hookServer = new HookServer(
      this.hive,
      (ch, p) => this.emit(ch, p),
      () => readConfig(),
      this.control,
      this.breaker
    );

    this.reflector = new MemoryReflector(
      getHome,
      () => readConfig().defaultCommand ?? 'claude',
      () => this.deps.memoryEnv(),
      () => this.reflectSettings(),
      (event) => { try { this.hive.appendLog(event); } catch { /* best-effort */ } }
    );

    this.syncManager = new SyncManager(
      () => {
        const c = readConfig();
        return {
          enabled: c.syncEnabled === true,
          url: c.supabaseUrl ?? '',
          anonKey: c.supabaseAnonKey ?? '',
          workspaceId: teamSyncWorkspaceId(teamId, c)
        };
      },
      getHome,
      this.deps.persist,
      {
        emit: (channel, payload) => {
          const wc = this.deps.liveWebContents();
          if (wc) try { wc.send(channel, payload); } catch { /* window tore down */ }
        },
        embed: (texts) => {
          const s = this.memorySettings();
          if (!s.enabled) return Promise.resolve(null);
          return ollamaEmbed(texts, s, 'document');
        },
        hive: {
          readStateRows: () => this.hive.readStateRows(),
          pulse: () => this.hive.pulse(),
          applyStateRows: (r) => this.hive.applyStateRows(r)
        }
      }
    );

    this.thoughts = new ThoughtsService(
      getHome,
      () => readConfig().defaultCommand ?? 'claude',
      () => readConfig().agentThoughtsEnabled !== false,
      () => this.syncManager.canRunMemory(),
      (body) => this.syncManager.appendBoardEntry({
        board: 'agent', body, authorKind: 'agent', agentId: 'orchestrator'
      })
    );
  }

  // ─── emit stamping (the §6.3 contract) ─────────────────────────────────────

  /** The single renderer sink for THIS team. Every per-team push event routes
   *  through here so it carries a `teamId` — the rule that lets the renderer demux
   *  N concurrent team streams (§6.3). Object payloads gain a `teamId` field
   *  (additive — back-compat: an unmigrated single-team renderer ignores it);
   *  non-object payloads pass through untouched. Returns true iff delivered (the
   *  HiveManager + HookServer's terminal-handoff path read the boolean). Wired
   *  into: HiveManager emit, the HookServer (hookEvent/contextUpdate/
   *  approvalRequest), the telemetry collector (telemetry:event), the breaker beat
   *  (control:breakerState), and the mission scheduler (mission:autoCompact,
   *  missions:updated). Supabase sync events stay raw — they're keyed by remote
   *  workspace, orthogonal to local teams. */
  emit(channel: string, payload: unknown): boolean {
    const wc = this.deps.liveWebContents();
    if (!wc) return false;
    const stamped =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? { ...(payload as Record<string, unknown>), teamId: this.teamId }
        : payload;
    try { wc.send(channel, stamped); return true; } catch { return false; }
  }

  // ─── live settings (read fresh each tick) ──────────────────────────────────

  private memorySettings(): MemorySettings {
    const c = readConfig();
    return {
      enabled: c.semanticMemory !== false,
      host: c.ollamaHost ?? 'http://localhost:11434',
      model: c.ollamaEmbedModel ?? 'nomic-embed-text'
    };
  }

  private reflectSettings(): ReflectSettings {
    const c = readConfig();
    return {
      enabled: c.reflectEnabled !== false,
      intervalMs: c.reflectIntervalMs ?? 1_800_000,
      byteTriggerPct: c.reflectByteTriggerPct ?? 50,
      sectionTrigger: c.reflectSectionTrigger ?? 50,
      recentKeep: c.reflectRecentKeep ?? 12,
      minBytes: c.reflectMinBytes ?? 16_384
    };
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  /** Start every hive-bound background service for this team against its current
   *  home. No-op without a home. Mirrors the old `bootstrapHiveServices`, scoped
   *  to one team. Idempotent on the always-on timers (a re-start can't stack
   *  duplicates). The global memory/persist services are owned by
   *  index.ts, not here. */
  start(): void {
    if (!this.hive.enabled()) return;
    this.started = true;
    this.hive.ensureHive();
    // Route this team's messages to the closing-time coordinator (BE-8), so it
    // collects CLOSING-TIME-ACK/COMPLETE per team. Set once per start().
    this.hive.setRoutedObserver((msg, targets) => this.deps.onRouted?.(this.teamId, msg, targets));
    this.hive.startRouter();
    // The built-in ops-standup + heartbeat missions live on the GLOBAL config and
    // belong to the default team; clones seed their own at clone time.
    if (this.isDefault) ensureDefaultMissions();
    this.syncMissions();
    this.hookServer.start();
    // Bind telemetry BEFORE the renderer spawns any agent, then point the hive at
    // it so every subsequent spawn is instrumented. Best-effort.
    void this.telemetry.start().then((r) => {
      if (r.ok && r.endpoint) { this.hive.setOtelEndpoint(r.endpoint); console.log(`[telemetry:${this.teamId}] collector listening`, r.endpoint); }
      else console.error(`[telemetry:${this.teamId}] collector failed to start:`, r.error);
    });
    this.reflector.start();
    this.thoughts.start();
    // Auto-start sync when enabled (self-gates on a complete config + lazy import).
    if (readConfig().syncEnabled) void this.syncManager.start();

    // Always-on beats: fleet snapshot (~8s) + breaker/cost-ledger beat (~30s).
    if (this.fleetTimer) clearInterval(this.fleetTimer);
    this.writeFleetSnapshot();
    this.fleetTimer = setInterval(() => this.writeFleetSnapshot(), 8_000);
    if (this.breakerBeatTimer) clearInterval(this.breakerBeatTimer);
    this.breakerBeatTimer = setInterval(() => { try { this.runBreakerBeat(300_000); } catch (e) { console.error(`[breaker beat:${this.teamId}]`, e); } }, 30_000);
  }

  /** Tear down every service + timer this team owns. Best-effort — a throw here
   *  must never abort a quit/reset/changeHome. Globals (memory/persist/
   *  ptyManager) are stopped by index.ts. */
  stop(): void {
    this.started = false;
    try { this.clearMissionTimers(); } catch (e) { console.error(`[stop:${this.teamId}] clearMissionTimers:`, e); }
    if (this.fleetTimer) { clearInterval(this.fleetTimer); this.fleetTimer = null; }
    if (this.breakerBeatTimer) { clearInterval(this.breakerBeatTimer); this.breakerBeatTimer = null; }
    try { this.hive.stopRouter(); } catch (e) { console.error(`[stop:${this.teamId}] stopRouter:`, e); }
    try { this.hookServer.stop(); } catch (e) { console.error(`[stop:${this.teamId}] hookServer.stop:`, e); }
    try { this.telemetry.stop(); } catch (e) { console.error(`[stop:${this.teamId}] telemetry.stop:`, e); }
    try { this.syncManager.stop(); } catch { /* best-effort */ }
    try { this.reflector.stop(); } catch (e) { console.error(`[stop:${this.teamId}] reflector.stop:`, e); }
    try { this.thoughts.stop(); } catch (e) { console.error(`[stop:${this.teamId}] thoughts.stop:`, e); }
  }

  // ─── mission scheduler (per-team) ──────────────────────────────────────────

  /** This team's mission list (default team falls back to the global list). */
  private missions(): ScheduledMission[] {
    return teamMissions(this.teamId, readConfig());
  }

  /** Persist a mutated mission list to the right place (default → global config;
   *  clone → its own TeamConfig.missions). Shared with the missions:save IPC. */
  private persistMissions(next: ScheduledMission[]): void {
    setTeamMissions(this.teamId, next);
  }

  /** Clear + forget every armed mission timer (both setTimeout + setInterval). */
  private clearMissionTimers(): void {
    for (const t of this.missionTimers.values()) {
      if (t.timeout) clearTimeout(t.timeout);
      if (t.interval) clearInterval(t.interval);
    }
    this.missionTimers.clear();
  }

  /** Rebuild the scheduler from this team's missions: clear, then arm each enabled
   *  mission honoring lastFiredAt. Called from start() and after a missions:save. */
  syncMissions(): void {
    this.clearMissionTimers();
    for (const m of this.missions()) {
      if (!m.enabled || !(m.intervalMs > 0)) continue;
      if (m.kind === 'heartbeat') { this.armHeartbeat(m); continue; }
      const fire = (): void => {
        try {
          if (this.hive.enabled()) {
            this.hive.send({ to: m.to, act: 'request', subject: m.label, body: m.body }, 'scheduler');
          }
          // Auto-compact: hand to the renderer, which queues a /compact per agent
          // and delivers it when that agent goes idle (never mid-step).
          if (m.autoCompact) this.emit('mission:autoCompact', {});
          const next = this.missions().map((x) => (x.id === m.id ? { ...x, lastFiredAt: Date.now() } : x));
          this.persistMissions(next);
          this.emit('missions:updated', {});
        } catch (e) {
          console.error(`[scheduler:${this.teamId}] mission`, m.id, e);
        }
      };
      const remaining = Math.max(0, m.intervalMs - (Date.now() - (m.lastFiredAt ?? 0)));
      const entry: MissionTimer = {};
      entry.timeout = setTimeout(() => {
        fire();
        entry.interval = setInterval(fire, m.intervalMs);
      }, remaining);
      this.missionTimers.set(m.id, entry);
    }
  }

  // ─── heartbeat (Lane A #1) + circuit-breaker beat (#6.6b) ──────────────────

  /** Arm the heartbeat with an adaptive, self-rescheduling cadence. */
  private armHeartbeat(m: ScheduledMission): void {
    const base = m.intervalMs;
    const quiet = m.quietThresholdMs ?? 300_000;
    const beat = (): void => {
      let next = base;
      try {
        if (this.isFloorQuiet(quiet)) {
          this.reengageGod(this.buildHeartbeatDigest(quiet));
          next = Math.round(base * 2.5);
        } else if (this.looksStuck(quiet)) {
          next = Math.max(30_000, Math.round(base / 4));
        }
        const cur = this.missions().map((x) => (x.id === m.id ? { ...x, lastFiredAt: Date.now() } : x));
        this.persistMissions(cur);
        this.emit('missions:updated', {});
      } catch (e) {
        console.error(`[heartbeat:${this.teamId}]`, e);
      }
      const entry = this.missionTimers.get(m.id) ?? {};
      entry.timeout = setTimeout(beat, next);
      this.missionTimers.set(m.id, entry);
    };
    const remaining = Math.max(0, base - (Date.now() - (m.lastFiredAt ?? 0)));
    this.missionTimers.set(m.id, { timeout: setTimeout(beat, remaining) });
  }

  /** Is this team's floor quiet? Derived only from signals main owns/can stat —
   *  log.jsonl mtime, each agent's inbox + outbox/.sent mtimes, every live PTY's
   *  lastOutputAt. NOT registry.status (never transitions in main). */
  private isFloorQuiet(thresholdMs: number): boolean {
    const root = this.hive.root();
    if (!root) return false;
    const times: number[] = [];
    const pushMtime = (p: string): void => { try { times.push(statSync(p).mtimeMs); } catch { /* missing */ } };
    pushMtime(join(root, 'log.jsonl'));
    const agentsDir = join(root, 'agents');
    if (existsSync(agentsDir)) {
      for (const id of readdirSync(agentsDir)) {
        pushMtime(join(agentsDir, id, 'inbox'));
        pushMtime(join(agentsDir, id, 'outbox', '.sent'));
      }
    }
    for (const t of this.deps.ptyManager.list()) times.push(t.lastOutputAt);
    if (times.length === 0) return false;
    return Date.now() - Math.max(...times) > thresholdMs;
  }

  /** Newest coordination-file mtime for one agent (inbox, outbox/.sent, memory.md)
   *  — FILES only, deliberately excluding PTY output. */
  private lastCoordinationAt(agentId: string): number {
    const root = this.hive.root();
    if (!root) return 0;
    const times: number[] = [0];
    const pushMtime = (p: string): void => { try { times.push(statSync(p).mtimeMs); } catch { /* missing */ } };
    const dir = join(root, 'agents', agentId);
    pushMtime(join(dir, 'inbox'));
    pushMtime(join(dir, 'outbox', '.sent'));
    pushMtime(join(dir, 'memory.md'));
    return Math.max(...times);
  }

  /** PTY id owning a given agent id IN THIS TEAM, or undefined. Filters by teamId
   *  so two teams that both have e.g. a `backend` never cross-match (BE-6). */
  private ptyForAgent(agentId: string): string | undefined {
    for (const [ptyId, o] of this.deps.ptyToAgent) {
      if (o.teamId === this.teamId && o.agentId === agentId) return ptyId;
    }
    return undefined;
  }

  /** "Stuck" = a worker's PTY is actively printing while its coordination files
   *  have gone stale — working-but-not-coordinating. */
  private looksStuck(windowMs: number): boolean {
    const reg = this.hive.registry();
    const now = Date.now();
    for (const [id, a] of Object.entries(reg.agents)) {
      if (a.archived || id === reg.godId) continue;
      const ptyId = this.ptyForAgent(id);
      if (!ptyId) continue;
      const idle = this.deps.ptyManager.idleFor(ptyId) ?? Infinity;
      if (idle < 15_000 && now - this.lastCoordinationAt(id) > windowMs) return true;
    }
    return false;
  }

  /** Bounded digest for god — paths + counts, never full files. */
  private buildHeartbeatDigest(quietMs: number): string {
    const reg = this.hive.registry();
    const active = Object.entries(reg.agents).filter(([id, a]) => !a.archived && id !== reg.godId);
    const names = active.map(([, a]) => a.name).join(', ') || '—';
    const boardHead = this.hive.board().split('\n').slice(0, 10).join('\n').trim();
    const log = this.hive.logTail(8).map((e) => { try { return JSON.stringify(e); } catch { return ''; } }).filter(Boolean).join('\n');
    const withInbox = active.filter(([id]) => this.hive.inbox(id).length > 0).map(([, a]) => a.name);
    return [
      `Idle heartbeat — quiet ~${Math.round(quietMs / 60000)}m.`,
      `Active agents (${active.length}): ${names}.`,
      withInbox.length ? `Undrained inbox: ${withInbox.join(', ')}.` : 'No undrained inboxes.',
      '',
      'Board (head):',
      boardHead || '(empty)',
      '',
      'Recent log:',
      log || '(none)',
      '',
      'Re-engage anyone stalled or blocked and keep the board accurate — or rest if the work is genuinely done.'
    ].join('\n');
  }

  /** Re-engage a quiet floor: drop a durable digest into this team's god inbox. */
  private reengageGod(digest: string): void {
    if (!this.hive.enabled()) return;
    this.hive.send({ to: 'god', act: 'request', subject: 'Heartbeat', body: digest }, 'heartbeat');
  }

  /** A native toast for breaker constrain/stop, gated on the notifications setting. */
  private breakerToast(title: string, body: string): void {
    if (!readConfig().notifications) return;
    try { if (Notification.isSupported()) new Notification({ title, body }).show(); }
    catch { /* unsupported platform */ }
  }

  /** One circuit-breaker beat: pull a fresh usage sample per active agent, append
   *  it to the durable cost ledger, tick the breaker, emit each BreakerState, and
   *  enforce escalation. God is in the LEDGER but NOT the breaker inputs. */
  private runBreakerBeat(progressWindowMs: number): void {
    if (!this.hive.enabled()) return;
    const reg = this.hive.registry();
    const now = Date.now();
    const inputs: BreakerInput[] = [];
    for (const [id, a] of Object.entries(reg.agents)) {
      if (a.archived) continue;
      const sample = this.usageProvider.getAgentUsage(id);
      if (sample) this.hive.appendCostLedger(sample);
      if (id === reg.godId) continue;
      inputs.push({ agentId: id, sample, progressing: now - this.lastCoordinationAt(id) < progressWindowMs });
    }
    for (const d of this.breaker.tick(inputs, now)) {
      this.emit('control:breakerState', d.state);
      if (d.action === 'none') continue;
      const name = reg.agents[d.state.agentId]?.name ?? d.state.agentId;
      const reason = d.state.reason;
      if (d.action === 'steer') {
        this.hive.send({ to: d.state.agentId, act: 'request', subject: 'Circuit breaker: steer',
          body: `Automated guardrail: ${reason}. Re-check your approach — if you're looping or stuck, STOP repeating, summarize what you've tried, and ask god for direction.` }, 'breaker');
      } else if (d.action === 'constrain') {
        this.hive.send({ to: d.state.agentId, act: 'request', subject: 'Circuit breaker: constrain',
          body: `Automated guardrail escalated: ${reason}. Stop active work now: switch to read-only/plan, write a short plan of your next step, and send it to god for sign-off BEFORE running more tools.` }, 'breaker');
        this.breakerToast(`${name} constrained`, reason);
      } else if (d.action === 'stop') {
        const ptyId = this.ptyForAgent(d.state.agentId);
        if (ptyId) { try { this.deps.ptyManager.kill(ptyId); } catch { /* already gone */ } this.deps.teardownPty(ptyId); }
        this.breakerToast(`${name} stopped by circuit breaker`, reason);
      }
    }
  }

  /** Build + write this team's live fleet snapshot (`<root>/fleet.json`). */
  private writeFleetSnapshot(): void {
    if (!this.hive.enabled()) return;
    try {
      const reg = this.hive.registry();
      const snap = this.telemetry.snapshot();
      const usageById = new Map(snap.usage.map((u) => [u.agentId, u]));
      const now = Date.now();
      const agents = Object.entries(reg.agents)
        .filter(([, a]) => !a.archived)
        .map(([id, a]) => {
          const u = usageById.get(id);
          const spans = snap.spans[id] ?? [];
          const tokens = u ? u.input + u.output + u.cacheRead + u.cacheCreation : 0;
          return {
            id,
            name: a.name,
            role: a.role ?? (a.isGod ? 'orchestrator' : 'agent'),
            cwd: a.cwd,
            isGod: !!a.isGod,
            breaker: this.breaker.levelFor(id),
            tokens,
            usd: u ? Number(u.usd.toFixed(4)) : 0,
            lastTool: spans.length ? spans[spans.length - 1].tool : null,
            lastActiveSecAgo: u ? Math.round((now - u.ts) / 1000) : null,
            inboxBacklog: this.hive.inboxBacklog(id)
          };
        });
      this.hive.writeFleetSnapshot({ ts: now, agents });
    } catch (e) {
      console.error(`[fleet:${this.teamId}] snapshot failed:`, e);
    }
  }
}
