import { useEffect, useRef } from 'react';
import { useStore, DEFAULT_TEAM_ID, teamAgentEntries, type Agent, type GodStatus, type QueuedMessage, type StationKind, type ToolKind } from '@/store/store';
import {
  buildSpawnCommand,
  tokenizeCommand,
  ASSISTANT_MODEL,
  inferAgentProvider,
  isClaudeProvider,
  type HarnessConfig
} from '@/store/config';
import { teamsList, godPtyId, workerPtyId, teamCwd, teamIdOf, spawnPtyForTeam, hiveInboxFor } from '@/ipc/teams';
import { AGENT_PRESETS } from '@/components/AddAgentModal';

const GOD_ID = 'god';

// Per-team-agent ref key. The booking/dedup refs below (breaker level, inbox-wake
// dedup, flush cooldown, boot grace) are keyed by this so two teams that both
// have a `god`/`backend` never clobber each other's per-agent state.
const rk = (teamId: string, agentId: string): string => `${teamId}:${agentId}`;

// How long to let Claude Code's TUI finish booting before we type the first
// thing into the orchestrator's terminal, and how long to PAUSE after the /remote-control
// command so the slash command lands + executes on its own line before the
// orientation prompt follows (otherwise they jam into one line and the TUI shows
// "Unknown command: /remote-control…").
const GOD_BOOT_MS = 4000;
const REMOTE_CONTROL_SETTLE_MS = 1500;
// After a god/agent spawn, hold off the inbox-wake + queue-drain typers for this
// long so they can't interleave with the boot sequence (remote-control +
// orientation) and jam the input line.
const BOOT_GRACE_MS = GOD_BOOT_MS + REMOTE_CONTROL_SETTLE_MS + 2500;

// The first thing the god (orchestrator) is told on a fresh spawn — orient it
// and put it to work coordinating the team. Kept terse and action-oriented.
const INITIAL_GOD_PROMPT = [
  "You're online as the orchestrator of the hive. Get oriented, then start coordinating the team:",
  '1. Read your memory.md and drain every message in your inbox.',
  '2. Review board.md + tasks.json and the current roster of agents (active vs archived).',
  '3. Check fleet health: read fleet.json in the hive root for every agent\'s live tokens, cost, status, breaker level, and inbox backlog (`claude agents` will NOT show your hive\'s agents). Flag anyone stalled, over-budget, or breaker-armed.',
  '4. Skim COMMANDS.md (hive root) for the Claude Code commands you can use. Durable facts you and the team write to memory.md are embedded into a shared semantic memory automatically — write what matters there.',
  'Then begin orchestrating: triage requests, delegate work to the team, and keep everyone unblocked. You are fully autonomous — there is no approval queue, so handle tool-permission prompts in this session yourself (the human can approve them remotely from their phone).'
].join('\n');

// Scheduled auto-compact command (from the ops standup). Queued per agent and
// delivered when idle, so it never interrupts a working agent. The focus
// instructions make the agent record its current task + next step into the
// summary, so it resumes from the same point after compacting.
const COMPACT_CMD =
  '/compact Summarise exactly what you are currently working on and the next step, ' +
  'so you can resume from the same point — then continue that work after compacting.';

// Per-pty submission chain. Every submitToPty for a given pty is appended here so
// two callers (e.g. the boot sequence's /remote-control and the inbox-wake nudge)
// can NEVER interleave their text + Enter — which jammed them onto one line and
// produced "Unknown command: /remote-control<next prompt>".
const writeChains = new Map<string, Promise<void>>();

/**
 * Type a line into an agent's Claude Code TUI and actually submit it.
 *
 * Writing the text and the carriage return in a single chunk makes the TUI
 * treat the whole thing as a paste, so the "\r" lands as a newline inside the
 * input box instead of submitting — the command just sits there as text. We
 * send the text first, then the Enter as a separate keystroke a tick later so
 * the prompt is registered and executed. Idle autonomous agents thus act on a
 * dispatched instruction on their own.
 *
 * Submissions to the same pty are serialized (and each settles for `settleMs`
 * after Enter) so concurrent callers can't jam their input together.
 *
 * The text is wrapped in bracketed-paste markers (ESC[200~ … ESC[201~) so the
 * TUI treats it as ONE paste: embedded newlines land as literal newlines in the
 * input box. Without them, every "\n" in a multi-line message acted as Enter —
 * the message submitted line-by-line in fragments (the agent saw only the last
 * chunk). The closing Enter, sent a tick later, submits the whole block. (#24) */
function submitToPty(ptyId: string, text: string, settleMs = 250): Promise<void> {
  const prev = writeChains.get(ptyId) ?? Promise.resolve();
  const next = prev.catch(() => { /* a failed prior write must not stall the chain */ }).then(async () => {
    // Bracketed paste (ESC[200~ … ESC[201~) only matters for MULTI-LINE text, so a
    // stray "\n" doesn't submit early (#24). Single-line text (nudges, slash
    // commands) is sent raw — some TUIs (Antigravity's agy) treat the paste
    // markers as literal input and never submit, so skipping them is more robust.
    const payload = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;
    await window.cth.writePty(ptyId, payload);
    await new Promise((r) => setTimeout(r, 140));
    await window.cth.writePty(ptyId, '\r');
    await new Promise((r) => setTimeout(r, settleMs));
  });
  writeChains.set(ptyId, next);
  return next;
}

/** Wrap a user message as an enrich task for the assistant. The assistant's
 *  system prompt has the full instructions; this just frames the one task. */
function enrichTaskPrompt(text: string): string {
  return [
    `ENRICH TASK: ${text}`,
    '',
    '(Identify the relevant project, cd in, gather READ-ONLY context, then send the improved,',
    'self-contained prompt to the orchestrator via an outbox message with "to":"god". Do not do the task yourself.)'
  ].join('\n');
}

function terminalWorkOrderPrompt(msg: {
  id: string;
  from: string;
  act: string;
  subject: string;
  body: string;
  requiresReply: boolean;
  createdAt: string;
}): string {
  return [
    'WORK ORDER FROM HIVE',
    `Message: ${msg.id}`,
    `From: ${msg.from}`,
    `Subject: ${msg.subject}`,
    `Act: ${msg.act}${msg.requiresReply ? ' (reply expected)' : ''}`,
    `Issued: ${msg.createdAt}`,
    '',
    msg.body,
    '',
    'Notes:',
    '- This arrived through your terminal because this provider does not support hive inbox.',
    '- Work in your current cwd.',
    '- When done, report changes, validation, blockers, and next step in this terminal.'
  ].join('\n');
}

/** Tool name → where the avatar walks + what it carries. */
const TOOL_STATION: Record<string, { station: StationKind; carry?: ToolKind }> = {
  Read: { station: 'shelf', carry: 'Read' },
  Edit: { station: 'desk', carry: 'Edit' },
  Write: { station: 'desk', carry: 'Write' },
  Bash: { station: 'terminal', carry: 'Bash' },
  Grep: { station: 'shelf', carry: 'Grep' },
  Glob: { station: 'shelf', carry: 'Glob' },
  WebFetch: { station: 'web', carry: 'WebFetch' },
  WebSearch: { station: 'web', carry: 'WebSearch' },
  TodoWrite: { station: 'board', carry: 'TodoWrite' },
  // #5A — delegating to a sub-agent reads as "handing off at the outbox".
  Task: { station: 'mailbox', carry: 'TodoWrite' }
};

/** Resolve a tool name to its station/glyph. Falls back: any `mcp__*` tool →
 *  the MCP station (previously these silently sat at the desk, #5A gap); anything
 *  else → the desk. */
function stationForTool(tool: string): { station: StationKind; carry?: ToolKind } {
  if (TOOL_STATION[tool]) return TOOL_STATION[tool];
  if (tool.startsWith('mcp__')) return { station: 'mcp', carry: 'MCP' };
  // Heuristic fallback for non-Claude tool names (Antigravity sends run_command,
  // ListDir, write_file, … — its hook names differ from Claude's exact tags).
  // Match write/edit BEFORE read so "write_file" → desk, not shelf.
  const t = tool.toLowerCase();
  if (/command|bash|shell|exec|terminal|run_/.test(t)) return { station: 'terminal', carry: 'Bash' };
  if (/web|fetch|browser|http|url/.test(t)) return { station: 'web', carry: 'WebFetch' };
  if (/write|edit|create|patch|replace|apply/.test(t)) return { station: 'desk', carry: 'Write' };
  if (/read|list|view|dir|glob|grep|search|find|file|cat|\bls\b/.test(t)) return { station: 'shelf', carry: 'Read' };
  return { station: 'desk' };
}

/**
 * The renderer-side glue for the hive:
 *   1. spawns the god (orchestrator) agent when none is running,
 *   2. drives avatar state from real Claude Code hook events, and
 *   3. wakes idle agents that have unread inbox messages so collaboration
 *      doesn't stall while an agent sits at its prompt.
 */
export function useHive(config: HarnessConfig | null): void {
  // Per-agent dedup key for the inbox-wake nudge: the newest inbox message id we
  // last nudged about. Keyed by id (not count) so an oscillating count after a
  // drain doesn't re-nudge for the same message set.
  const nudged = useRef<Record<string, string>>({});
  // Per-agent timestamp of the last queued-message we submitted. Guards against
  // re-sending the next message before the agent's hooks have flipped it to
  // 'working' (there's a short window where it still reads 'idle' right after we
  // type into it). One message per cooldown keeps delivery strictly one-by-one.
  const lastFlush = useRef<Record<string, number>>({});
  // In-flight spawn guard, per team, so a re-render / StrictMode double-mount
  // can't spawn a team's orchestrator twice (the window between the listPtys
  // check and spawnPty is racy).
  const godSpawning = useRef<Set<string>>(new Set());
  // In-flight WORKER-bootstrap guard, per team — so the clone worker-spawn loop
  // (effect #1b) can't double-fire for the same team across re-renders / a
  // teamList bump while a prior pass is still spawning.
  const workersSpawning = useRef<Set<string>>(new Set());
  // Per-agent timestamp until which auto-typers (inbox-wake #3, queue-drain #4)
  // must leave the agent alone — set while its boot sequence is typing so nothing
  // collides with /remote-control + the orientation prompt.
  const bootGraceUntil = useRef<Record<string, number>>({});
  const seenTerminalHandoffs = useRef<Set<string>>(new Set());
  // Reactive so the assistant bootstrap (effect #1b) re-runs once the orchestrator is ready.
  const godStatus = useStore((s) => s.godStatus);
  // Reactive: a newly cloned team appended here must get its god bootstrapped too.
  const teamList = useStore((s) => s.teamList);
  // #5C/#7C.4 — latest circuit-breaker level per agent. When 'constrained'/
  // 'stopped' the avatar is pinned to 'looping' and hook events must NOT flip it
  // back to 'working' (the flicker the spec calls out); only a genuine Stop clears it.
  const breakerLevel = useRef<Record<string, string>>({});

  // 1) Bootstrap EVERY team's god in parallel (FE-3). Teams are always-live, so
  //    on app boot we iterate the team list and spawn each team's orchestrator
  //    that isn't already running (source of truth = live PTYs, to dodge
  //    restarts). A team is keyed by godPtyId(teamId) so two gods never collide.
  useEffect(() => {
    if (!config?.onboardingComplete || !config.harnessHome) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    // Set/clear god status on the right slice (active team mirrors to flat fields).
    const setGodStatusFor = (teamId: string, status: GodStatus): void => {
      const st = useStore.getState();
      if (teamId === st.activeTeamId) st.setGodStatus(status);
      else st.applyToTeam(teamId, () => ({ godStatus: status }));
    };
    // Add the god to the right team's slice. Active team uses addAgent (selects +
    // persists); background teams get a silent slice insert.
    const addGodToTeam = (teamId: string, god: Agent): void => {
      const st = useStore.getState();
      if (teamId === st.activeTeamId) { st.addAgent(god); return; }
      st.applyToTeam(teamId, (slice) => ({
        agents: [...slice.agents.filter((a) => a.id !== god.id), god],
        feeds: { ...slice.feeds, [god.id]: slice.feeds[god.id] ?? [] }
      }));
    };

    const spawnGod = async (teamId: string): Promise<void> => {
      const ptyId = godPtyId(teamId);
      const live = await window.cth.listPtys().catch(() => []);
      if (live.some((p) => p.id === ptyId)) { // already running — keep restored entry
        if (!cancelled) setGodStatusFor(teamId, 'ready');
        return;
      }
      // Synchronous guard (no await between check and set) → exactly one spawn/team.
      if (cancelled || godSpawning.current.has(teamId)) return;
      godSpawning.current.add(teamId);
      setGodStatusFor(teamId, 'booting');

      const cwd = teamCwd(config.harnessHome!, teamId);
      const command = buildSpawnCommand(config, config.defaultModel, 'claude');
      const [exe, ...args] = command.trim().split(/\s+/);
      const res = await spawnPtyForTeam({
        id: ptyId,
        cwd,
        command: exe,
        provider: 'claude',
        args,
        cols: 100,
        rows: 30,
        hive: { id: GOD_ID, name: 'Orchestrator', provider: 'claude', cwd, isGod: true, role: 'orchestrator (god)' }
      }, teamId);
      if (cancelled) { godSpawning.current.delete(teamId); return; }
      if (!res.ok) { godSpawning.current.delete(teamId); setGodStatusFor(teamId, 'failed'); return; }
      const god: Agent = {
        id: GOD_ID,
        name: 'Orchestrator',
        accent: 'lemon',
        description: 'god — coordinates the team, triages requests, escalates only critical calls to you',
        project: 'hive',
        tmuxTarget: '',
        cwd,
        status: 'idle',
        action: 'coordinating the team',
        progress: 0,
        currentStation: 'desk',
        ptyId,
        command: command.trim(),
        provider: 'claude',
        model: config.defaultModel,
        isGod: true,
        recentTextTs: Date.now()
      };
      addGodToTeam(teamId, god);
      setGodStatusFor(teamId, 'ready');
      godSpawning.current.delete(teamId);

      // Fresh spawn → kick the orchestrator off once its TUI is up. First enable
      // remote control so the human can approve permission prompts from their phone
      // (best-effort), PAUSE so it lands on its own line, then hand it the
      // orientation prompt. Both go through the per-pty submit chain (strictly
      // sequential); the boot-grace window keeps the inbox-wake/drain loops off
      // this god until it's oriented. Restored sessions skip this.
      bootGraceUntil.current[rk(teamId, GOD_ID)] = Date.now() + BOOT_GRACE_MS;
      timers.push(setTimeout(() => {
        if (cancelled) return;
        submitToPty(ptyId, '/remote-control', REMOTE_CONTROL_SETTLE_MS).catch(() => { /* best-effort */ });
        submitToPty(ptyId, INITIAL_GOD_PROMPT).catch(() => { /* pty may have died */ });
      }, GOD_BOOT_MS));
    };

    const t = setTimeout(async () => {
      if (cancelled) return;
      // Iterate the authoritative team list (falls back to the default team).
      const teams = await teamsList().catch(() => []);
      const ids = teams.length ? teams.map((tm) => tm.id) : [DEFAULT_TEAM_ID];
      for (const teamId of ids) {
        if (cancelled) break;
        void spawnGod(teamId);
      }
    }, 1200);
    return () => { cancelled = true; clearTimeout(t); timers.forEach(clearTimeout); };
    // teamList is a dep so a freshly cloned team's god is bootstrapped on append.
  }, [config?.onboardingComplete, config?.harnessHome, teamList]);

  // 1b) Bootstrap each team's WORKER roster (MT-CLONE-2 fix). A clone copies the
  //     source roster into the new team's registry.json but spawns ZERO worker
  //     PTYs, and a fresh clone's localStorage is empty — so only the per-team god
  //     (effect #1) ever appears. This mirrors the god-bootstrap: for every team,
  //     read its registry and spawn each non-god, non-assistant, non-archived
  //     worker that isn't ALREADY live (listPtys) or ALREADY in the slice. That
  //     in-slice skip is what leaves the default team's localStorage-restored
  //     roster untouched (no regression) — only a fresh clone (empty slice + no
  //     live PTYs) actually spawns here, yielding a fully-live working duplicate.
  useEffect(() => {
    if (!config?.onboardingComplete || !config.harnessHome) return;
    let cancelled = false;

    // Insert a freshly-spawned worker into the right team's slice. Active team uses
    // addAgent (selects + persists); background teams get a silent slice insert —
    // mirrors the god-bootstrap's addGodToTeam.
    const addWorkerToTeam = (teamId: string, agent: Agent): void => {
      const st = useStore.getState();
      if (teamId === st.activeTeamId) { st.addAgent(agent); return; }
      st.applyToTeam(teamId, (slice) => ({
        agents: [...slice.agents.filter((a) => a.id !== agent.id), agent],
        feeds: { ...slice.feeds, [agent.id]: slice.feeds[agent.id] ?? [] }
      }));
    };

    const spawnWorkersForTeam = async (teamId: string): Promise<void> => {
      if (cancelled || workersSpawning.current.has(teamId)) return;
      // The team's authoritative roster = its registry.json (the configs a clone
      // copied). No new IPC channel — the existing teamId-scoped query suffices.
      const reg = await window.cth.hiveRegistry(teamId).catch(() => null);
      if (!reg || cancelled) return;
      const workers = Object.values(reg.agents).filter(
        (m) => !m.isGod && !m.isAssistant && m.id !== reg.godId && !m.archived
      );
      if (!workers.length) return;
      workersSpawning.current.add(teamId);
      try {
        const live = await window.cth.listPtys().catch(() => []);
        for (const meta of workers) {
          if (cancelled) break;
          const ptyId = workerPtyId(teamId, meta.id);
          // Already running, or already represented in the slice (e.g. the default
          // team's restored roster) → leave it alone. Re-read the slice each
          // iteration so workers added earlier in THIS loop aren't re-spawned.
          if (live.some((p) => p.id === ptyId)) continue;
          if (useStore.getState().teams[teamId]?.agents.some((a) => a.id === meta.id)) continue;

          // Spawn opts mirror AddAgentModal. Preserve each cloned agent's preset
          // model/accent by id (cloned agents keep the source ids) so the duplicate
          // is faithful; custom/non-preset agents fall back to the config defaults.
          const preset = AGENT_PRESETS.find((p) => p.id === meta.id);
          const provider = meta.provider ?? 'claude';
          const model = isClaudeProvider(provider)
            ? (preset?.model ?? config.defaultModel)
            : undefined;
          const command = buildSpawnCommand(config, model, provider);
          const [exe, ...args] = tokenizeCommand(command.trim());
          const res = await spawnPtyForTeam({
            id: ptyId,
            cwd: meta.cwd,
            command: exe,
            provider,
            args,
            cols: 100,
            rows: 30,
            hive: {
              id: meta.id,
              name: meta.name,
              provider,
              cwd: meta.cwd,
              role: meta.role,
              capabilities: meta.capabilities
            }
          }, teamId);
          if (cancelled) break;
          if (!res.ok) continue;
          addWorkerToTeam(teamId, {
            id: meta.id,
            name: meta.name,
            accent: preset?.accent ?? 'sky',
            description: meta.role ?? 'a fresh harness',
            project: meta.cwd.split('/').filter(Boolean).pop() ?? meta.cwd,
            tmuxTarget: '',
            cwd: meta.cwd,
            status: 'idle',
            action: 'starting up',
            progress: 0,
            currentStation: 'desk',
            ptyId,
            command: command.trim(),
            provider,
            model,
            recentTextTs: Date.now()
          });
        }
      } finally {
        workersSpawning.current.delete(teamId);
      }
    };

    // Fire slightly after the god-bootstrap (1200ms) so each team's god comes up
    // first, then its workers join it.
    const t = setTimeout(async () => {
      if (cancelled) return;
      const teams = await teamsList().catch(() => []);
      const ids = teams.length ? teams.map((tm) => tm.id) : [DEFAULT_TEAM_ID];
      for (const teamId of ids) {
        if (cancelled) break;
        void spawnWorkersForTeam(teamId);
      }
    }, 1600);
    return () => { cancelled = true; clearTimeout(t); };
    // teamList dep → a freshly cloned team's workers bootstrap on append.
  }, [config?.onboardingComplete, config?.harnessHome, teamList]);

  // 2) Drive avatars from real hook events emitted by each agent's shim.
  useEffect(() => {
    return window.cth.onHiveHookEvent((e) => {
      if (!e.agentId) return;
      // FE-2: demux by the event's team so off-screen teams' rosters stay current.
      const teamId = teamIdOf(e);
      const self = useStore.getState().teams[teamId]?.agents.find((a) => a.id === e.agentId);
      if (!self) return;
      const updateAgent = (id: string, patch: Partial<Agent>): void =>
        useStore.getState().updateAgentIn(teamId, id, patch);
      // Breaker precedence (#5C): a constrained/stopped agent stays 'looping'
      // regardless of in-flight tool/prompt/compact events.
      const blevel = breakerLevel.current[rk(teamId, e.agentId)];
      const breakerArmed = blevel === 'constrained' || blevel === 'stopped';
      // Hook events are the authoritative status source for real agents (the
      // pty-stream parser only refines the action/station).
      if (e.event === 'PreCompact') {
        // #5C — agent entered /compact; show it's boxing up context, not frozen.
        if (!breakerArmed) updateAgent(e.agentId, { status: 'compacting', action: 'compacting context', carrying: undefined });
      } else if (e.event === 'PostCompact') {
        if (!breakerArmed) updateAgent(e.agentId, { status: 'working', action: 'resumed', carrying: undefined });
      } else if (e.event === 'PreToolUse' && e.tool) {
        const m = stationForTool(e.tool);
        if (!breakerArmed) updateAgent(e.agentId, { status: 'working', currentStation: m.station, carrying: m.carry, action: `using ${e.tool}` });
        useStore.getState().bumpToolCountIn(teamId, e.agentId); // usage proxy for the command center
      } else if (e.event === 'PostToolUse' || e.event === 'UserPromptSubmit') {
        // A turn is in progress (prompt submitted / tool just finished) — keep
        // it working so it doesn't flicker idle between tool calls.
        if (!breakerArmed) updateAgent(e.agentId, { status: 'working' });
      } else if (e.event === 'PreInvocation') {
        // Antigravity (agy): the model is being called — it's thinking/working.
        if (!breakerArmed) updateAgent(e.agentId, { status: 'working', action: 'thinking' });
      } else if (e.event === 'PostInvocation') {
        // agy's per-turn boundary. Unlike Claude, agy's Stop fires only on process
        // EXIT, so without this an agy worker would never register as idle and the
        // inbox-wake nudge (idle-only) could never reach it — its mail would sit
        // undrained. Treat it as idle; a follow-up tool/turn re-sets working.
        if (!breakerArmed) updateAgent(e.agentId, { status: 'idle', action: 'idle', carrying: undefined });
      } else if (e.event === 'Stop' || e.event === 'SubagentStop') {
        // A blocked Stop means the agent is being re-engaged to process its
        // inbox — it's NOT idle, so keep it working until it genuinely stops.
        if (e.blocked) {
          if (!breakerArmed) updateAgent(e.agentId, { status: 'working', action: 'reading inbox', carrying: undefined });
        } else {
          // A genuine stop clears any breaker override — the run is over.
          breakerLevel.current[rk(teamId, e.agentId)] = 'healthy';
          updateAgent(e.agentId, { status: 'idle', action: 'idle', carrying: undefined });
        }
      } else if (e.event === 'Notification' && !breakerArmed) {
        // Claude Code fires Notification for two very different situations:
        //   1. it genuinely needs the human (a permission / approval prompt), or
        //   2. the prompt has merely gone idle ("Claude is waiting for your
        //      input") — i.e. the agent answered and has nothing queued.
        // Only (1) is a real "needs you". Treating (2) as blocked falsely flagged
        // the orchestrator right after finishing, so detect the idle case and
        // leave its status as idle instead.
        const msg = (e.message ?? '').toLowerCase();
        const idleWaiting = !msg
          || msg.includes('waiting for your input')
          || msg.includes('is idle')
          || msg.includes('waiting for input');
        const needsHuman = msg.includes('permission')
          || msg.includes('approve')
          || msg.includes('confirm')
          || msg.includes('needs your');
        if (needsHuman && !idleWaiting) {
          // Only the god agent escalates to the human; sub-agents are autonomous
          // and read as "waiting" (parked on god, not on you).
          updateAgent(e.agentId, { status: self.isGod ? 'blocked' : 'waiting' });
        } else {
          // Idle notification — responded, nothing to do. Linger, don't flag.
          updateAgent(e.agentId, { status: 'idle', action: 'idle', carrying: undefined });
        }
      }
    });
  }, []);

  // 2b) Consume circuit-breaker state (#7C.4/#5C). Lane A's breaker policy (#6)
  //     pushes BreakerState on `control:breakerState`; this gives it PRECEDENCE
  //     over hook-derived status: a constrained/stopped agent is pinned to
  //     'looping' (see the breakerArmed guard above) until it genuinely Stops.
  useEffect(() => {
    return window.cth.onBreakerState((s) => {
      const teamId = teamIdOf(s);
      breakerLevel.current[rk(teamId, s.agentId)] = s.level;
      const slice = useStore.getState().teams[teamId];
      if (!slice?.agents.some((a) => a.id === s.agentId)) return;
      if (s.level === 'constrained' || s.level === 'stopped') {
        useStore.getState().updateAgentIn(teamId, s.agentId, { status: 'looping', action: s.reason || 'breaker armed', carrying: undefined });
      }
      // 'healthy'/'steering' clear the pin; the next hook event refreshes status.
    });
  }, []);

  // 2c) Context gauge backfill: poll each live agent's current context size
  //     (tokens) from its session transcript — only until the status line
  //     (effect 2d) has delivered exact numbers for that agent.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const poll = async () => {
      const { agents, updateAgent } = useStore.getState();
      for (const a of agents) {
        if (!a.ptyId) continue;
        // The status line pushes exact numbers after every response (effect
        // 2d) — this transcript poll only backfills agents whose status line
        // hasn't fired yet (e.g. freshly restored, no response so far).
        if (a.contextLimit !== undefined) continue;
        try {
          const ctx = await window.cth.agentContext(a.id);
          if (ctx === null) continue;
          const hinted = /1m/i.test(a.model ?? '') ? 1_000_000 : 200_000;
          const limit = Math.max(hinted, ctx > 200_000 ? 1_000_000 : 0);
          const progress = Math.max(0, Math.min(8, Math.round((ctx / limit) * 8)));
          updateAgent(a.id, { contextTokens: ctx, progress });
        } catch { /* ignore — try again next tick */ }
      }
    };
    const t = setTimeout(poll, 3000); // first fill shortly after boot
    const iv = setInterval(poll, 15000);
    return () => { clearTimeout(t); clearInterval(iv); };
  }, [config?.onboardingComplete]);

  // 2d) Push-based context gauge: the status-line shim forwards the session's
  //     EXACT context accounting (tokens + real window size) after every
  //     response — no probing, no transcript guesswork.
  useEffect(() => {
    return window.cth.onHiveContextUpdate((e) => {
      const { agentId, tokens, limit } = e;
      // Defense-in-depth: the main process already filters limit > 0, but the
      // renderer must not trust IPC blindly — limit 0 would put NaN progress
      // into the store (NaN survives the Math.min/max clamp).
      if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(tokens)) return;
      const progress = Math.max(0, Math.min(8, Math.round((tokens / limit) * 8)));
      useStore.getState().updateAgentIn(teamIdOf(e), agentId, { contextTokens: tokens, contextLimit: limit, progress });
    });
  }, []);

  // 2e) Non-Claude providers cannot drain hive inbox. Direct hive mail to them
  //     arrives here as a terminal work order and is queued through the same
  //     idle-only PTY drain as human-composed messages.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onHiveTerminalHandoff((msg) => {
      if (seenTerminalHandoffs.current.has(msg.id)) return;
      const teamId = teamIdOf(msg);
      const slice = useStore.getState().teams[teamId];
      const enqueueMessage = (agentId: string, text: string): void =>
        useStore.getState().enqueueMessageIn(teamId, agentId, text);
      const target = slice?.agents.find((a) => a.id === msg.to);
      if (target?.ptyId) {
        const marker = `Message: ${msg.id}`;
        if ((slice?.messageQueues[target.id] ?? []).some((queued) => queued.text.includes(marker))) return;
        seenTerminalHandoffs.current.add(msg.id);
        enqueueMessage(target.id, terminalWorkOrderPrompt(msg));
        return;
      }
      seenTerminalHandoffs.current.add(msg.id);
      enqueueMessage(
        GOD_ID,
        [
          `Terminal handoff failed for ${msg.to}: ${msg.subject}`,
          '',
          `Message ${msg.id} from ${msg.from} could not be queued because ${msg.to} has no live PTY. Route it manually or respawn the agent.`
        ].join('\n')
      );
    });
  }, [config?.onboardingComplete]);

  // 3) Wake idle agents holding unread inbox messages. The assistant is
  //    send-only (it never receives inbox mail), so it's excluded.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const iv = setInterval(async () => {
      const now = Date.now();
      // Iterate EVERY team's agents — background teams stay live, so their idle
      // agents must still be woken for unread inbox mail (keyed per team+agent).
      const entries = teamAgentEntries(useStore.getState()).filter(
        ({ teamId, agent: a }) => a.ptyId && (a.status === 'idle' || a.status === 'waiting')
          // Don't type into an agent still running its boot sequence — the nudge
          // would collide with /remote-control + the orientation prompt.
          && (bootGraceUntil.current[rk(teamId, a.id)] ?? 0) < now
      );
      for (const { teamId, agent: a } of entries) {
        try {
          const inbox = await hiveInboxFor(a.id, teamId);
          // Dedup by the newest message id, not the count — a count can oscillate
          // as messages drain and re-arrive, which would re-nudge for the same set.
          const newest = inbox.length
            ? inbox.map((m) => m.id).sort().slice(-1)[0]
            : '';
          const nkey = rk(teamId, a.id);
          if (newest && nudged.current[nkey] !== newest) {
            nudged.current[nkey] = newest;
            await submitToPty(
              a.ptyId!,
              'You have new hive inbox message(s) — read your inbox, act on them now, and move handled ones to inbox/.done/. Act autonomously; only message god if you genuinely need a decision.'
            );
          } else if (!newest) {
            nudged.current[nkey] = '';
          }
        } catch { /* ignore */ }
      }
    }, 4000);
    return () => clearInterval(iv);
  }, [config?.onboardingComplete]);

  // 4) Drain each agent's queued messages to its terminal, one at a time, the
  //    moment the agent goes idle. This is what lets the user keep sending
  //    messages while the agent's "cloud terminal" is mid-run: the messages
  //    park in the store and get typed in (and submitted) as soon as it's free.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const FLUSH_COOLDOWN_MS = 4500;

    // Send the front of `srcId`'s queue into `target`'s pty (verbatim or wrapped),
    // gated on the target being idle + off cooldown. Keyed cooldown per target so
    // strict one-by-one delivery holds. Returns true if it dispatched.
    const dispatch = (teamId: string, srcId: string, target: Agent | undefined, wrap?: (m: QueuedMessage) => string): boolean => {
      const slice = useStore.getState().teams[teamId];
      const next = slice?.messageQueues[srcId]?.[0];
      if (!next || !target?.ptyId || target.status !== 'idle') return false;
      const now = Date.now();
      const tkey = rk(teamId, target.id);
      // Hold queued messages until the target finishes its boot sequence.
      if ((bootGraceUntil.current[tkey] ?? 0) >= now) return false;
      if (now - (lastFlush.current[tkey] ?? 0) < FLUSH_COOLDOWN_MS) return false;
      lastFlush.current[tkey] = now;
      // Remove first so a burst of store updates can't double-send the same one.
      useStore.getState().removeQueuedMessageIn(teamId, srcId, next.id);
      // Zero the gauge instantly on /clear — the new session's context isn't
      // known until statusLine fires after the first post-clear response, so
      // leaving it at the old value shows a stale-full bar during that window.
      if (next.text.trim().toLowerCase() === '/clear') {
        useStore.getState().updateAgentIn(teamId, target.id, { contextTokens: 0, contextLimit: undefined, progress: 0 });
      }
      submitToPty(target.ptyId, wrap ? wrap(next) : next.text).catch(() => { /* pty may have died */ });
      return true;
    };

    // Promote a genuine Slack-origin work item to a stamped kanban card the first
    // time it's dispatched to the office. The card carries slack:{channel,thread_ts}
    // (origin thread) so the main-process done-observer can post its one summary
    // reply in-thread once the card later reaches 'done'. ADDITIVE + idempotent +
    // best-effort: a failure here never affects the dispatch that already happened,
    // and only dispatched work items land here (slash commands/acks never do).
    type SlackTaskCard = Parameters<typeof window.cth.hiveWriteTasks>[0][number];
    const ensureSlackCard = async (m: QueuedMessage): Promise<void> => {
      const slack = m.slack;
      if (!slack) return;
      try {
        const raw = await window.cth.hiveTasks();
        const existing: SlackTaskCard[] =
          raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)
            ? (raw as { tasks: SlackTaskCard[] }).tasks
            : [];
        const id = `slack-${slack.thread_ts}-${m.id}`;
        if (existing.some((t) => t.id === id)) return; // already promoted — no dup
        const title = m.text.length > 80 ? `${m.text.slice(0, 79)}…` : m.text;
        const card: SlackTaskCard = {
          id,
          title,
          description: m.text,
          status: 'todo',
          dependsOn: [],
          priority: 1,
          createdAt: new Date().toISOString(),
          slack
        };
        await window.cth.hiveWriteTasks([...existing, card]);
      } catch { /* best-effort: card promotion must never sink dispatch */ }
    };

    const flush = () => {
      // Drain across ALL teams — a background team's queued messages must still be
      // delivered the moment its agent idles (the PTY is live regardless of view).
      for (const { teamId, agent: a } of teamAgentEntries(useStore.getState())) {
        if (!a.ptyId || a.status !== 'idle') continue;
        const queue = useStore.getState().teams[teamId]?.messageQueues[a.id];
        if (!queue?.length) continue;
        const head = queue[0];
        if (dispatch(teamId, a.id, a) && head.slack) void ensureSlackCard(head);
      }
    };

    // Run on every store change (status flips, new queue items) — debounced so a
    // burst of pty-stream updates coalesces — plus a periodic backstop.
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (debounce) return;
      debounce = setTimeout(() => { debounce = null; flush(); }, 200);
    };
    const unsub = useStore.subscribe(schedule);
    const iv = setInterval(flush, 3000);
    schedule();
    return () => { unsub(); if (debounce) clearTimeout(debounce); clearInterval(iv); };
  }, [config?.onboardingComplete]);

  // 5) Pipe inbound Slack messages into the orchestrator's queue. The main-process
  //    Slack webhook server pushes each verified message here via IPC; enqueueing to
  //    GOD_ID lands it in the orchestrator's queue exactly as if the user had typed it
  //    into the composer — effect #4 above then drains it to its PTY.
  //    We immediately ack in the triggering thread and stash the thread coords
  //    so the hive can post its summary back later.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onSlackMessage((msg) => {
      if (!msg?.text?.trim()) return;
      const text = msg.text.trim();
      if (!text) return;
      const slack = { channel: msg.channel, thread_ts: msg.thread_ts };
      // Slack/webhook are global singletons routed to ONE primary team (the
      // default), per architect §7.3 — enqueue to that god, not the active team.
      useStore.getState().enqueueMessageIn(DEFAULT_TEAM_ID, GOD_ID, text, { slack });
      // Immediate "queued" acknowledgement in the originating Slack thread.
      void window.cth.slackReply({
        channel: msg.channel,
        thread_ts: msg.thread_ts,
        text: 'Your request is queued — the Hive team will start working shortly.'
      });
    });
  }, [config?.onboardingComplete]);

  // 5b) Pipe hive tasks addressed to non-Claude agents (e.g. Codex) into their
  //     terminal queues. When main routes a message to a non-claude provider it
  //     emits 'hive:enqueueToAgent' instead of bouncing; we enqueue the raw
  //     task text here so effect #4 types it into the REPL when the agent idles.
  //     No inbox nudge, no /compact — just the verbatim subject+body text.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onHiveEnqueue?.((msg) => {
      if (!msg?.targetId || !msg?.text?.trim()) return;
      useStore.getState().enqueueMessageIn(teamIdOf(msg), msg.targetId, msg.text.trim());
    });
  }, [config?.onboardingComplete]);

  // 6) Auto-compact (scheduled standup). Main fires this per tick; we queue a
  //    /compact for each live agent so the drain (#4) delivers it only when the
  //    agent is idle — never jamming a working terminal. Deduped: if a /compact
  //    is already queued for an agent, skip it (no second one piles up).
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onAutoCompact((e?: { teamId?: string }) => {
      // The tick may target one team (e.teamId) or, when arg-less, all teams.
      const only = e && typeof e === 'object' ? e.teamId : undefined;
      const entries = teamAgentEntries(useStore.getState())
        .filter(({ teamId }) => !only || teamId === only);
      for (const { teamId, agent: a } of entries) {
        if (!a.ptyId) continue;
        // /compact is a Claude Code slash command — non-Claude CLIs (agy, codex)
        // would just receive it as literal prompt text. Skip them.
        if (!isClaudeProvider(inferAgentProvider(a.command, a.provider))) continue;
        const queued = useStore.getState().teams[teamId]?.messageQueues[a.id] ?? [];
        if (queued.some((m) => m.text.trimStart().startsWith('/compact'))) continue;
        useStore.getState().enqueueMessageIn(teamId, a.id, COMPACT_CMD);
      }
    });
  }, [config?.onboardingComplete]);
}
