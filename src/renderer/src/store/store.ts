import { create } from 'zustand';
import type { AccentColorName } from '@/design/tokens';
import type { StatusKind } from '@/components/PixelBadge';
import type { AgentProvider } from '@shared/agentProvider';

export type ToolKind =
  | 'Read' | 'Edit' | 'Write' | 'Bash' | 'WebFetch' | 'WebSearch'
  | 'Grep' | 'Glob' | 'TodoWrite' | 'MCP';

export type StationKind =
  | 'shelf' | 'terminal' | 'web' | 'board' | 'mailbox' | 'mcp' | 'desk';

export interface BlockReason {
  summary: string;                 // short headline shown on banner
  detail: string;                  // longer explanation
  command?: string;                // verbatim command awaiting confirmation, if any
  actions: Array<{
    label: string;
    kind: 'approve' | 'deny' | 'neutral';
    /** what we'd send to the tmux pane on click */
    send?: string;
  }>;
}

export interface Agent {
  id: string;
  name: string;
  accent: AccentColorName;
  /** persistent short context — what is this agent for (shown on the floor) */
  description: string;
  project: string;
  /** legacy field — populated only for the seeded mock agents */
  tmuxTarget: string;
  cwd: string;
  goal?: string;
  status: StatusKind;
  action: string;
  progress: number;
  currentStation?: StationKind;
  carrying?: ToolKind;
  /** latest assistant message, streamed character-by-character in the sidebar */
  recentAssistantText?: string;
  /** epoch ms — used to drive the typewriter so identical strings still re-stream */
  recentTextTs?: number;
  /** populated when status === 'blocked' */
  blockReason?: BlockReason;
  /** present iff this agent has a real PTY in the main process */
  ptyId?: string;
  /** the command being run in the PTY (e.g. 'claude' or 'agy') */
  command?: string;
  /** which agent CLI preset owns this PTY recipe; drives the model picker +
   *  spawn flags. Defaults to 'claude' when unset (legacy agents / inferred
   *  from command). */
  provider?: AgentProvider;
  /** the model this agent runs on (e.g. 'claude-sonnet-4-6[1m]' or 'gemini-3-pro');
   *  drives the model selector + the --model arg used when (re)spawning the agent */
  model?: string;
  /** the last prompt the user submitted to this agent in Claude Code */
  lastPrompt?: string;
  /** the orchestrator ("god") agent — coordinates the team */
  isGod?: boolean;
  /** the orchestrator's prep assistant — send-only; enriches prompts and forwards
   *  them to the god. Excluded from broadcast fan-out and from the restorable-dead sweep. */
  isAssistant?: boolean;
  /** When git isolation is enabled, the dedicated worktree path the agent runs
   *  in (its own `agent/<id>` branch); undefined for shared-cwd agents. */
  worktreePath?: string;
  /** Live context size of the agent's Claude session (tokens), polled from its
   *  transcript. Drives the context gauge on the agent card. */
  contextTokens?: number;
  /** The context-window limit assumed for this agent's model (tokens). */
  contextLimit?: number;
  /** True once this agent's terminal was closed. Archived agents are retained
   *  (in the store's `archivedAgents` list + the hive registry) but flagged and
   *  kept off the floor; only live-PTY agents are 'active'. */
  archived?: boolean;
}

export interface FeedEntry {
  agentId: string;
  text: string;
  ts: number;
}

/** A message the user has parked for an agent while its terminal was busy.
 *  Queued messages are drained one at a time when the agent next goes idle (see
 *  useHive's flush loop). */
export interface QueuedMessage {
  id: string;
  text: string;
  /** epoch ms the message was queued — drives ordering and the "queued 2m ago" hint */
  ts: number;
}

export type SidebarTab = 'terminal' | 'files' | 'messages' | 'traces' | 'prompt' | 'config';

/** Which surface the center panel shows: the task kanban or the shared Notepad
 *  (team pulse / scratchpad / agent library / pinned links). */
export type CenterView = 'kanban' | 'notepad';

/** Prefill for the Add-Agent modal. Setting a non-null prefill in the store ALSO
 *  opens the modal; it's cleared when the modal closes. Sourced from the Agent
 *  Library's "Add to my hive" (a published SharedAgent → a local spawn). */
export interface AddAgentPrefill {
  name?: string;
  role?: string;
  model?: string;
  accent?: string;
  capabilities?: string[];
  customPrompt?: string;
}

/** Lifecycle of the god agent (orchestrator) bootstrap on launch.
 *  'booting' until its PTY is confirmed live, then 'ready' (or 'failed' if the
 *  spawn errored). The empty-dashboard UI shows a loader while 'booting' so users
 *  don't see the "add agent" prompt before the orchestrator has started. */
export type GodStatus = 'booting' | 'ready' | 'failed';

/** The legacy/default team id. Existing single-hive installs are this team; its
 *  on-disk hive + localStorage keys keep their pre-multi-team names so nothing
 *  regresses. Mirrors the main-process default team (architect findings §2). */
export const DEFAULT_TEAM_ID = 'default';

/** A team as listed for the TeamSelector. Mirrors the `teams:list` IPC shape
 *  (findings §6.1) — fields beyond id/name are best-effort and arrive from the
 *  main process (FE-2 / BE-7); until then a team is just {id, name}. */
export interface TeamSummary {
  id: string;
  name: string;
  createdAt?: number;
  godId?: string;
  /** runtime is live in the main process (parallel teams are always running) */
  running?: boolean;
  /** active (non-archived) agent count, for the selector badge */
  agentCount?: number;
}

/** All per-team renderer state. Today's single-hive fields, now keyed by team.
 *  One slice per team in `State.teams`; the slice for `activeTeamId` is mirrored
 *  onto the top-level State fields so existing components (which read `s.agents`,
 *  `s.godStatus`, …) keep working unchanged and always see the active team. */
export interface TeamSlice {
  agents: Agent[];
  archivedAgents: Agent[];
  restorableAgents: Agent[];
  selectedId: string | null;
  feeds: Record<string, string[]>;
  messageQueues: Record<string, QueuedMessage[]>;
  toolCounts: Record<string, number>;
  drafts: Record<string, string>;
  answerDrafts: Record<string, string>;
  godStatus: GodStatus;
}

interface State {
  /** Per-team state slices, keyed by teamId. Source of truth for per-team data.
   *  The active team's slice is mirrored onto the flat fields below. */
  teams: Record<string, TeamSlice>;
  /** Which team is in view. Its slice drives the mirrored flat fields. */
  activeTeamId: string;
  /** All known teams (for the TeamSelector). Distinct from `viewedOwner`, which
   *  is read-only Supabase teammate viewing. */
  teamList: TeamSummary[];
  /** Switch the in-view team: re-mirror its slice onto the flat fields. NEVER
   *  stops/unmounts other teams — they stay live in the main process (§7.7). */
  setActiveTeam: (teamId: string) => void;
  /** Replace the known-team list (from `teams:list`). Ensures a slice exists for
   *  every listed team so switching is instant. */
  setTeamList: (list: TeamSummary[]) => void;
  /** Add/refresh one team (from a `teams:event` create/status). Accepts a partial
   *  so a status-only event (running/agentCount) merges without clobbering name.
   *  Creates an empty slice if the team is new; does not switch to it. */
  upsertTeam: (summary: Partial<TeamSummary> & { id: string }) => void;
  /** Drop a team (from a `teams:event` remove). Falls back to the default/first
   *  team if the active one was removed. */
  removeTeam: (teamId: string) => void;
  /** Route a per-team mutation into the right slice — the primitive FE-2 uses to
   *  demux `teamId`-stamped push events (findings §6.3). `mutate` receives the
   *  target team's current slice and returns the fields to change. If the target
   *  is the active team, the flat mirror is updated too; background teams update
   *  silently. Auto-creates the slice if the team isn't known yet. */
  applyToTeam: (teamId: string, mutate: (slice: TeamSlice) => Partial<TeamSlice>) => void;
  /** Team-scoped variant of updateAgent — patch one agent in a specific team's
   *  slice (FE-2: route a teamId-stamped status/hook event to the right team,
   *  even when that team is off-screen). Mirrors to flat fields iff it's active. */
  updateAgentIn: (teamId: string, id: string, patch: Partial<Agent>) => void;
  /** Team-scoped tool-count bump (per-team usage proxy). */
  bumpToolCountIn: (teamId: string, id: string) => void;
  /** Team-scoped enqueue — park a message for an agent in a specific team so the
   *  drain loop delivers it even while that team is in the background. Persists to
   *  the team's namespaced queue store. */
  enqueueMessageIn: (teamId: string, agentId: string, text: string) => void;
  /** Team-scoped queued-message removal (used by the drain loop for any team). */
  removeQueuedMessageIn: (teamId: string, agentId: string, messageId: string) => void;
  agents: Agent[];
  /** Agents whose terminal was closed — retained + flagged, kept off the active
   *  roster/floor. The hive registry retains them durably; this mirrors them for
   *  the renderer's "Archived" view. */
  archivedAgents: Agent[];
  /** Workers from the previous session whose terminal died with the app (quit /
   *  crash). Kept with their full spawn recipe (id, cwd, model, command) so the
   *  user can one-click respawn them with the SAME agent id — memory, inbox and
   *  registry entry reattach by themselves. God/assistant are excluded (they
   *  auto-respawn). */
  restorableAgents: Agent[];
  selectedId: string | null;
  feeds: Record<string, string[]>;
  addAgentOpen: boolean;
  /** Center-panel surface toggle: the task kanban (default) or the Notepad. */
  centerView: CenterView;
  setCenterView: (v: CenterView) => void;
  /** Pending prefill for the Add-Agent modal — non-null ALSO opens the modal
   *  (consumed by the modal on mount, cleared when it closes). */
  addAgentPrefill: AddAgentPrefill | null;
  setAddAgentPrefill: (p: AddAgentPrefill | null) => void;
  fullscreenAgentId: string | null;
  fullscreenFilePath: string | null;
  sidebarWidth: number;
  sidebarTab: SidebarTab;
  godStatus: GodStatus;
  /** Per-agent outgoing message queue (agent id → messages awaiting delivery).
   *  Lets the user keep "talking" to a busy agent: messages park here and are
   *  drained to the terminal one-by-one once the agent is free. */
  messageQueues: Record<string, QueuedMessage[]>;
  /** Per-agent tool-call count this session — a lightweight activity/usage proxy
   *  shown in the command center (interactive sessions don't expose billed $). */
  toolCounts: Record<string, number>;
  bumpToolCount: (id: string) => void;
  setGodStatus: (status: GodStatus) => void;
  select: (id: string) => void;
  updateAgent: (id: string, patch: Partial<Agent>) => void;
  pushFeed: (id: string, line: string) => void;
  addAgent: (agent: Agent) => void;
  removeAgent: (id: string) => void;
  /** Archive an agent (its terminal was closed): move it from the active roster
   *  into `archivedAgents` with its PTY cleared. Retained + flagged, NOT deleted. */
  archiveAgent: (id: string) => void;
  /** Permanently forget an archived agent (drops the renderer entry only; the
   *  hive registry keeps its record). */
  removeArchivedAgent: (id: string) => void;
  /** Drop one agent from the restorable list (it was respawned or dismissed). */
  removeRestorableAgent: (id: string) => void;
  /** One-shot request to open a Command-Center tab (e.g. clicking a dashboard
   *  task link → 'tasks'). `seq` makes repeated identical requests distinct. */
  ccTabRequest: { tab: string; seq: number } | null;
  requestCommandCenterTab: (tab: string) => void;
  /** Bumped after a successful agent Publish so the Notepad's Agent Library
   *  reloads immediately instead of waiting for its ~15s poll. */
  sharedAgentsNonce: number;
  bumpSharedAgents: () => void;
  /** The hive currently being VIEWED in the dashboard: null = your own (local),
   *  else a teammate's {machineId, ownerLabel}. ONE shared selection drives the
   *  roster + kanban together (read-only for a teammate). Ephemeral — not persisted. */
  viewedOwner: { machineId: string; ownerLabel: string | null } | null;
  setViewedOwner: (owner: { machineId: string; ownerLabel: string | null } | null) => void;
  /** The task whose detail overlay is open (rendered app-wide — the card content
   *  grows: contracts, deps, the human Q&A trail). */
  taskDetailId: string | null;
  openTaskDetail: (id: string) => void;
  closeTaskDetail: () => void;
  /** One-shot prefill for the Command Center's dispatch box (a task detail's
   *  "assign" from anywhere in the app). seq-keyed like ccTabRequest. */
  dispatchSeedRequest: { text: string; seq: number } | null;
  requestDispatchSeed: (text: string) => void;
  /** Unsent ASK ME answer drafts, keyed by task id — so switching tabs (which
   *  unmounts the ask-me view) doesn't eat a half-typed answer. */
  answerDrafts: Record<string, string>;
  setAnswerDraft: (taskId: string, text: string) => void;
  /** Unsent composer drafts, per agent — so switching agents (which remounts the
   *  composer) doesn't eat what the user was typing. */
  drafts: Record<string, string>;
  setDraft: (agentId: string, text: string) => void;
  /** Park a message for an agent. Returns nothing; the flush loop delivers it. */
  enqueueMessage: (agentId: string, text: string) => void;
  /** Drop a single queued message (user removed it, or it was just delivered). */
  removeQueuedMessage: (agentId: string, messageId: string) => void;
  /** Clear an agent's entire pending queue. */
  clearQueue: (agentId: string) => void;
  setAddAgentOpen: (open: boolean) => void;
  setFullscreen: (id: string | null) => void;
  setFullscreenFile: (path: string | null) => void;
  setSidebarWidth: (px: number) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  /** Drop persisted agents whose PTY is no longer alive in the main process.
   *  Called once at startup so a renderer reload (e.g. after the laptop sleeps)
   *  restores still-running agents and only removes truly-dead ones. */
  reconcileWithLivePtys: (livePtyIds: string[]) => void;
}

const LS_SIDEBAR_WIDTH = 'cth.sidebarWidth';
const LS_SIDEBAR_TAB = 'cth.sidebarTab';
const LS_AGENTS = 'cth.agents';
const LS_ARCHIVED = 'cth.archivedAgents';
const LS_RESTORABLE = 'cth.restorableAgents';
const LS_SELECTED = 'cth.selectedId';
const LS_QUEUES = 'cth.messageQueues';
const LS_ACTIVE_TEAM = 'cth.activeTeamId';

// Per-team localStorage namespacing. The default team keeps the legacy key names
// (so existing single-hive installs reload their agents); other teams suffix the
// team id. Persistence operates on whichever team is active — `activePersistTeam`
// tracks it so the persist/load helpers (which run outside the store) stay simple.
let activePersistTeam = DEFAULT_TEAM_ID;
function pkey(base: string, teamId: string = activePersistTeam): string {
  return teamId === DEFAULT_TEAM_ID ? base : `${base}.${teamId}`;
}

// Fields that are large or transient — not worth persisting across reloads.
// contextTokens/contextLimit describe a LIVE session; persisting them showed a
// dead session's context gauge after a restart until the poll caught up.
type PersistedAgent = Omit<Agent, 'recentAssistantText' | 'recentTextTs' | 'blockReason' | 'contextTokens' | 'contextLimit'>;

function persistAgents(agents: Agent[], selectedId: string | null, teamId: string = activePersistTeam): void {
  try {
    const slim: PersistedAgent[] = agents.map(({ recentAssistantText, recentTextTs, blockReason, contextTokens, contextLimit, ...rest }) => {
      void recentAssistantText; void recentTextTs; void blockReason; void contextTokens; void contextLimit;
      return rest;
    });
    window.localStorage.setItem(pkey(LS_AGENTS, teamId), JSON.stringify(slim));
    window.localStorage.setItem(pkey(LS_SELECTED, teamId), selectedId ?? '');
  } catch { /* noop */ }
}

function loadPersistedAgents(teamId: string = activePersistTeam): Agent[] {
  try {
    const raw = window.localStorage.getItem(pkey(LS_AGENTS, teamId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistedAgent[];
    if (!Array.isArray(parsed)) return [];
    // Reset volatile run-state; the PTY stream / mock loop will repopulate it.
    return parsed.map((a) => ({
      ...a,
      progress: 0,
      status: 'idle',
      action: 'reconnecting…',
      currentStation: 'desk',
      carrying: undefined,
      recentTextTs: Date.now(),
    }));
  } catch {
    return [];
  }
}

function persistArchived(archived: Agent[], teamId: string = activePersistTeam): void {
  try {
    const slim: PersistedAgent[] = archived.map(({ recentAssistantText, recentTextTs, blockReason, contextTokens, contextLimit, ...rest }) => {
      void recentAssistantText; void recentTextTs; void blockReason; void contextTokens; void contextLimit;
      return rest;
    });
    window.localStorage.setItem(pkey(LS_ARCHIVED, teamId), JSON.stringify(slim));
  } catch { /* noop */ }
}

function loadPersistedArchived(teamId: string = activePersistTeam): Agent[] {
  try {
    const raw = window.localStorage.getItem(pkey(LS_ARCHIVED, teamId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistedAgent[];
    if (!Array.isArray(parsed)) return [];
    // Archived agents have no live process — force the flag + clear run-state.
    return parsed.map((a) => ({
      ...a,
      archived: true,
      status: 'idle',
      ptyId: undefined,
      carrying: undefined,
      currentStation: undefined
    }));
  } catch {
    return [];
  }
}

function persistRestorable(restorable: Agent[], teamId: string = activePersistTeam): void {
  try {
    const slim: PersistedAgent[] = restorable.map(({ recentAssistantText, recentTextTs, blockReason, ...rest }) => {
      void recentAssistantText; void recentTextTs; void blockReason;
      return rest;
    });
    window.localStorage.setItem(pkey(LS_RESTORABLE, teamId), JSON.stringify(slim));
  } catch { /* noop */ }
}

function loadPersistedRestorable(teamId: string = activePersistTeam): Agent[] {
  try {
    const raw = window.localStorage.getItem(pkey(LS_RESTORABLE, teamId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistedAgent[];
    if (!Array.isArray(parsed)) return [];
    // No live process — clear run-state; the spawn recipe fields are what matter.
    return parsed.map((a) => ({
      ...a,
      status: 'idle',
      carrying: undefined,
      currentStation: undefined
    }));
  } catch {
    return [];
  }
}

function persistQueues(queues: Record<string, QueuedMessage[]>, teamId: string = activePersistTeam): void {
  try {
    // Only keep non-empty queues so the key stays small.
    const slim: Record<string, QueuedMessage[]> = {};
    for (const [id, q] of Object.entries(queues)) if (q.length) slim[id] = q;
    window.localStorage.setItem(pkey(LS_QUEUES, teamId), JSON.stringify(slim));
  } catch { /* noop */ }
}

function loadPersistedQueues(teamId: string = activePersistTeam): Record<string, QueuedMessage[]> {
  try {
    const raw = window.localStorage.getItem(pkey(LS_QUEUES, teamId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, QueuedMessage[]>;
    if (!parsed || typeof parsed !== 'object') return {};
    // Defensively keep only well-formed entries.
    const out: Record<string, QueuedMessage[]> = {};
    for (const [id, q] of Object.entries(parsed)) {
      if (Array.isArray(q)) {
        out[id] = q.filter((m) => m && typeof m.text === 'string' && typeof m.id === 'string');
      }
    }
    return out;
  } catch {
    return {};
  }
}

function loadPersistedSelectedId(agents: Agent[], teamId: string = activePersistTeam): string | null {
  try {
    const id = window.localStorage.getItem(pkey(LS_SELECTED, teamId));
    return id && agents.some((a) => a.id === id) ? id : (agents[0]?.id ?? null);
  } catch {
    return agents[0]?.id ?? null;
  }
}
const initialSidebarWidth = (() => {
  try {
    const v = window.localStorage.getItem(LS_SIDEBAR_WIDTH);
    const n = v ? parseInt(v, 10) : NaN;
    if (!Number.isNaN(n) && n >= 320 && n <= 1200) return n;
  } catch { /* noop */ }
  return 420;
})();
const initialSidebarTab: SidebarTab = (() => {
  try {
    const v = window.localStorage.getItem(LS_SIDEBAR_TAB);
    if (v === 'files' || v === 'terminal' || v === 'messages' || v === 'traces' || v === 'prompt' || v === 'config') return v;
  } catch { /* noop */ }
  return 'terminal';
})();

/** An empty per-team slice — for a team we know of but haven't loaded/populated. */
function emptySlice(): TeamSlice {
  return {
    agents: [], archivedAgents: [], restorableAgents: [], selectedId: null,
    feeds: {}, messageQueues: {}, toolCounts: {}, drafts: {}, answerDrafts: {},
    godStatus: 'booting'
  };
}

/** Hydrate a team's slice from its (namespaced) localStorage. toolCounts/drafts/
 *  answerDrafts/godStatus are session-volatile and start fresh, mirroring the
 *  pre-multi-team behavior where only agents/archived/restorable/queues persisted. */
function loadTeamSlice(teamId: string): TeamSlice {
  const agents = loadPersistedAgents(teamId);
  return {
    agents,
    archivedAgents: loadPersistedArchived(teamId),
    restorableAgents: loadPersistedRestorable(teamId),
    selectedId: loadPersistedSelectedId(agents, teamId),
    feeds: {},
    messageQueues: loadPersistedQueues(teamId),
    toolCounts: {},
    drafts: {},
    answerDrafts: {},
    godStatus: 'booting'
  };
}

// Boot active team: restore the last-viewed team if persisted, else the default.
// Set `activePersistTeam` first so the legacy initial* loads below resolve the
// correct (namespaced) keys.
const initialActiveTeamId = (() => {
  try { return window.localStorage.getItem(LS_ACTIVE_TEAM) || DEFAULT_TEAM_ID; }
  catch { return DEFAULT_TEAM_ID; }
})();
activePersistTeam = initialActiveTeamId;

const initialActiveSlice = loadTeamSlice(initialActiveTeamId);
const initialAgents = initialActiveSlice.agents;
const initialArchivedAgents = initialActiveSlice.archivedAgents;
const initialRestorableAgents = initialActiveSlice.restorableAgents;
const initialSelectedId = initialActiveSlice.selectedId;
const initialQueues = initialActiveSlice.messageQueues;

// Until the main process reports the full list (FE-2 / `teams:list`), we know of
// the default team plus the restored active team. Slices map starts with the
// active team's hydrated slice; the default gets an empty slice if distinct.
const initialTeams: Record<string, TeamSlice> = { [initialActiveTeamId]: initialActiveSlice };
if (!initialTeams[DEFAULT_TEAM_ID]) initialTeams[DEFAULT_TEAM_ID] = emptySlice();
const initialTeamList: TeamSummary[] = [
  { id: DEFAULT_TEAM_ID, name: 'Default' },
  ...(initialActiveTeamId !== DEFAULT_TEAM_ID ? [{ id: initialActiveTeamId, name: initialActiveTeamId }] : [])
];

let queuedSeq = 0;
/** Process-unique id for a queued message (timestamp + counter avoids collisions
 *  when several are queued within the same millisecond). */
function newQueuedId(): string {
  queuedSeq += 1;
  return `q-${Date.now()}-${queuedSeq}`;
}

/** The per-team-slice field names. Used to mirror flat-field writes into the
 *  active team's slice (see `withActive`). */
const SLICE_KEYS = [
  'agents', 'archivedAgents', 'restorableAgents', 'selectedId', 'feeds',
  'messageQueues', 'toolCounts', 'drafts', 'answerDrafts', 'godStatus'
] as const;

/** Wrap a flat-field state update so the active team's slice is kept in sync.
 *  Existing actions write the top-level fields (the mirror); this also folds the
 *  slice-relevant keys of that patch into `teams[activeTeamId]`, so the slice and
 *  its mirror never drift. Non-slice keys in the patch (e.g. addAgentOpen) pass
 *  straight through. Use for every action that mutates per-team data. */
function withActive(s: State, patch: Partial<State>): Partial<State> {
  const slicePatch: Partial<TeamSlice> = {};
  for (const k of SLICE_KEYS) {
    if (k in patch) (slicePatch as Record<string, unknown>)[k] = (patch as Record<string, unknown>)[k];
  }
  const active = s.teams[s.activeTeamId] ?? emptySlice();
  return {
    ...patch,
    teams: { ...s.teams, [s.activeTeamId]: { ...active, ...slicePatch } }
  };
}

export const useStore = create<State>((set) => ({
  teams: initialTeams,
  activeTeamId: initialActiveTeamId,
  teamList: initialTeamList,
  setActiveTeam: (teamId) =>
    set((s) => {
      if (teamId === s.activeTeamId) return s;
      const slice = s.teams[teamId] ?? loadTeamSlice(teamId);
      // Switch which team localStorage writes target, and remember the choice.
      activePersistTeam = teamId;
      try { window.localStorage.setItem(LS_ACTIVE_TEAM, teamId); } catch { /* noop */ }
      // Re-mirror the target slice onto the flat fields; ensure its slice exists.
      return {
        activeTeamId: teamId,
        teams: s.teams[teamId] ? s.teams : { ...s.teams, [teamId]: slice },
        agents: slice.agents,
        archivedAgents: slice.archivedAgents,
        restorableAgents: slice.restorableAgents,
        selectedId: slice.selectedId,
        feeds: slice.feeds,
        messageQueues: slice.messageQueues,
        toolCounts: slice.toolCounts,
        drafts: slice.drafts,
        answerDrafts: slice.answerDrafts,
        godStatus: slice.godStatus
      };
    }),
  setTeamList: (list) =>
    set((s) => {
      const teams = { ...s.teams };
      for (const t of list) if (!teams[t.id]) teams[t.id] = loadTeamSlice(t.id);
      // Keep the active team valid if it vanished from the list.
      const activeTeamId = list.some((t) => t.id === s.activeTeamId)
        ? s.activeTeamId
        : (list[0]?.id ?? DEFAULT_TEAM_ID);
      if (!teams[activeTeamId]) teams[activeTeamId] = emptySlice();
      return { teamList: list, teams, activeTeamId };
    }),
  upsertTeam: (summary) =>
    set((s) => {
      const exists = s.teamList.some((t) => t.id === summary.id);
      const teamList = exists
        ? s.teamList.map((t) => (t.id === summary.id ? { ...t, ...summary } : t))
        // New team: name defaults to its id until a fuller summary arrives.
        : [...s.teamList, { name: summary.id, ...summary }];
      const teams = s.teams[summary.id]
        ? s.teams
        : { ...s.teams, [summary.id]: loadTeamSlice(summary.id) };
      return { teamList, teams };
    }),
  removeTeam: (teamId) =>
    set((s) => {
      if (teamId === DEFAULT_TEAM_ID) return s; // never drop the default team
      const teamList = s.teamList.filter((t) => t.id !== teamId);
      const { [teamId]: _gone, ...teams } = s.teams;
      void _gone;
      if (s.activeTeamId !== teamId) return { teamList, teams };
      // Active team removed — fall back to default/first and re-mirror.
      const nextId = teams[DEFAULT_TEAM_ID] ? DEFAULT_TEAM_ID : (teamList[0]?.id ?? DEFAULT_TEAM_ID);
      const slice = teams[nextId] ?? emptySlice();
      activePersistTeam = nextId;
      try { window.localStorage.setItem(LS_ACTIVE_TEAM, nextId); } catch { /* noop */ }
      return {
        teamList, teams: teams[nextId] ? teams : { ...teams, [nextId]: slice },
        activeTeamId: nextId,
        agents: slice.agents, archivedAgents: slice.archivedAgents,
        restorableAgents: slice.restorableAgents, selectedId: slice.selectedId,
        feeds: slice.feeds, messageQueues: slice.messageQueues,
        toolCounts: slice.toolCounts, drafts: slice.drafts,
        answerDrafts: slice.answerDrafts, godStatus: slice.godStatus
      };
    }),
  applyToTeam: (teamId, mutate) =>
    set((s) => {
      const slice = s.teams[teamId] ?? emptySlice();
      const slicePatch = mutate(slice);
      const nextSlice = { ...slice, ...slicePatch };
      const teams = { ...s.teams, [teamId]: nextSlice };
      // If the mutated team is in view, mirror the changed fields onto the flat
      // fields too so subscribed components re-render.
      if (teamId === s.activeTeamId) {
        const mirror: Partial<State> = {};
        for (const k of SLICE_KEYS) {
          if (k in slicePatch) (mirror as Record<string, unknown>)[k] = (slicePatch as Record<string, unknown>)[k];
        }
        return { teams, ...mirror };
      }
      return { teams };
    }),
  updateAgentIn: (teamId, id, patch) =>
    useStore.getState().applyToTeam(teamId, (slice) => ({
      agents: slice.agents.map((a) => (a.id === id ? { ...a, ...patch } : a))
    })),
  bumpToolCountIn: (teamId, id) =>
    useStore.getState().applyToTeam(teamId, (slice) => ({
      toolCounts: { ...slice.toolCounts, [id]: (slice.toolCounts[id] ?? 0) + 1 }
    })),
  enqueueMessageIn: (teamId, agentId, text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const msg: QueuedMessage = {
      id: newQueuedId(), text: trimmed, ts: Date.now()
    };
    useStore.getState().applyToTeam(teamId, (slice) => {
      const messageQueues = { ...slice.messageQueues, [agentId]: [...(slice.messageQueues[agentId] ?? []), msg] };
      persistQueues(messageQueues, teamId);
      return { messageQueues };
    });
  },
  removeQueuedMessageIn: (teamId, agentId, messageId) =>
    useStore.getState().applyToTeam(teamId, (slice) => {
      const current = slice.messageQueues[agentId];
      if (!current) return {};
      const next = current.filter((m) => m.id !== messageId);
      const messageQueues = { ...slice.messageQueues, [agentId]: next };
      persistQueues(messageQueues, teamId);
      return { messageQueues };
    }),
  agents: initialAgents,
  archivedAgents: initialArchivedAgents,
  restorableAgents: initialRestorableAgents,
  selectedId: initialSelectedId,
  feeds: {},
  addAgentOpen: false,
  centerView: 'kanban',
  setCenterView: (v) => set({ centerView: v }),
  // Setting a non-null prefill opens the modal; clearing it leaves the modal
  // state to its own setAddAgentOpen toggle (cleared when the modal closes).
  addAgentPrefill: null,
  setAddAgentPrefill: (p) =>
    set(p ? { addAgentPrefill: p, addAgentOpen: true } : { addAgentPrefill: null }),
  ccTabRequest: null,
  requestCommandCenterTab: (tab) =>
    set((s) => ({ ccTabRequest: { tab, seq: (s.ccTabRequest?.seq ?? 0) + 1 } })),
  sharedAgentsNonce: 0,
  bumpSharedAgents: () => set((s) => ({ sharedAgentsNonce: s.sharedAgentsNonce + 1 })),
  viewedOwner: null,
  setViewedOwner: (owner) => set({ viewedOwner: owner }),
  fullscreenAgentId: null,
  fullscreenFilePath: null,
  sidebarWidth: initialSidebarWidth,
  sidebarTab: initialSidebarTab,
  godStatus: 'booting',
  messageQueues: initialQueues,
  toolCounts: {},
  bumpToolCount: (id) =>
    set((s) => withActive(s, { toolCounts: { ...s.toolCounts, [id]: (s.toolCounts[id] ?? 0) + 1 } })),
  setGodStatus: (status) => set((s) => withActive(s, { godStatus: status })),
  select: (id) => set((s) => { persistAgents(s.agents, id); return withActive(s, { selectedId: id }); }),
  updateAgent: (id, patch) =>
    set((s) => withActive(s, { agents: s.agents.map(a => a.id === id ? { ...a, ...patch } : a) })),
  pushFeed: (id, line) =>
    set((s) => withActive(s, { feeds: { ...s.feeds, [id]: [...(s.feeds[id] ?? []), line] } })),
  addAgent: (agent) =>
    set((s) => {
      const agents = [...s.agents, agent];
      // Re-spawning an archived agent un-archives it: an id is active xor archived.
      const archivedAgents = s.archivedAgents.filter((a) => a.id !== agent.id);
      // A live (re)spawn also consumes any restorable entry for the same id.
      const restorableAgents = s.restorableAgents.filter((a) => a.id !== agent.id);
      persistAgents(agents, agent.id);
      persistArchived(archivedAgents);
      if (restorableAgents.length !== s.restorableAgents.length) persistRestorable(restorableAgents);
      return withActive(s, {
        agents,
        archivedAgents,
        restorableAgents,
        selectedId: agent.id,
        feeds: { ...s.feeds, [agent.id]: s.feeds[agent.id] ?? [] }
      });
    }),
  removeAgent: (id) =>
    set((s) => {
      const agents = s.agents.filter(a => a.id !== id);
      const { [id]: _gone, ...feeds } = s.feeds;
      const { [id]: _queueGone, ...messageQueues } = s.messageQueues;
      const selectedId = s.selectedId === id ? (agents[0]?.id ?? null) : s.selectedId;
      persistAgents(agents, selectedId);
      if (_queueGone) persistQueues(messageQueues);
      return withActive(s, { agents, feeds, selectedId, messageQueues });
    }),
  archiveAgent: (id) =>
    set((s) => {
      const target = s.agents.find((a) => a.id === id);
      if (!target) return s;
      const agents = s.agents.filter((a) => a.id !== id);
      // Retain a flagged copy; the PTY is gone, so clear all live run-state.
      const archivedEntry: Agent = {
        ...target,
        archived: true,
        ptyId: undefined,
        status: 'idle',
        action: 'archived',
        carrying: undefined,
        currentStation: undefined
      };
      const archivedAgents = [...s.archivedAgents.filter((a) => a.id !== id), archivedEntry];
      const { [id]: _feedGone, ...feeds } = s.feeds;
      const { [id]: _queueGone, ...messageQueues } = s.messageQueues;
      const selectedId = s.selectedId === id ? (agents[0]?.id ?? null) : s.selectedId;
      persistAgents(agents, selectedId);
      persistArchived(archivedAgents);
      if (_queueGone) persistQueues(messageQueues);
      return withActive(s, { agents, archivedAgents, feeds, selectedId, messageQueues });
    }),
  removeArchivedAgent: (id) =>
    set((s) => {
      if (!s.archivedAgents.some((a) => a.id === id)) return s;
      const archivedAgents = s.archivedAgents.filter((a) => a.id !== id);
      persistArchived(archivedAgents);
      return withActive(s, { archivedAgents });
    }),
  removeRestorableAgent: (id) =>
    set((s) => {
      if (!s.restorableAgents.some((a) => a.id === id)) return s;
      const restorableAgents = s.restorableAgents.filter((a) => a.id !== id);
      persistRestorable(restorableAgents);
      return withActive(s, { restorableAgents });
    }),
  taskDetailId: null,
  openTaskDetail: (id) => set({ taskDetailId: id }),
  closeTaskDetail: () => set({ taskDetailId: null }),
  dispatchSeedRequest: null,
  requestDispatchSeed: (text) =>
    set((s) => ({ dispatchSeedRequest: { text, seq: (s.dispatchSeedRequest?.seq ?? 0) + 1 } })),
  answerDrafts: {},
  setAnswerDraft: (taskId, text) =>
    set((s) => withActive(s, { answerDrafts: { ...s.answerDrafts, [taskId]: text } })),
  drafts: {},
  setDraft: (agentId, text) =>
    set((s) => withActive(s, { drafts: { ...s.drafts, [agentId]: text } })),
  enqueueMessage: (agentId, text) =>
    set((s) => {
      const trimmed = text.trim();
      if (!trimmed) return s;
      const msg: QueuedMessage = {
        id: newQueuedId(), text: trimmed, ts: Date.now()
      };
      const messageQueues = { ...s.messageQueues, [agentId]: [...(s.messageQueues[agentId] ?? []), msg] };
      persistQueues(messageQueues);
      return withActive(s, { messageQueues });
    }),
  removeQueuedMessage: (agentId, messageId) =>
    set((s) => {
      const current = s.messageQueues[agentId];
      if (!current) return s;
      const next = current.filter((m) => m.id !== messageId);
      const messageQueues = { ...s.messageQueues, [agentId]: next };
      persistQueues(messageQueues);
      return withActive(s, { messageQueues });
    }),
  clearQueue: (agentId) =>
    set((s) => {
      if (!s.messageQueues[agentId]?.length) return s;
      const messageQueues = { ...s.messageQueues, [agentId]: [] };
      persistQueues(messageQueues);
      return withActive(s, { messageQueues });
    }),
  reconcileWithLivePtys: (livePtyIds) =>
    set((s) => {
      const live = new Set(livePtyIds);
      // Keep agents with no PTY (synthetic) or whose PTY is still alive.
      const agents = s.agents.filter((a) => !a.ptyId || live.has(a.ptyId));
      if (agents.length === s.agents.length) return s;
      // Workers whose terminal died with the previous session become restorable
      // (full spawn recipe retained) instead of silently vanishing. God and the
      // prep assistant are excluded — they auto-respawn at boot.
      const dead = s.agents.filter(
        (a) => a.ptyId && !live.has(a.ptyId) && !a.isGod && !a.isAssistant
      );
      const restorableAgents = [
        ...s.restorableAgents.filter((r) => !dead.some((d) => d.id === r.id)),
        ...dead
      ];
      const feeds: Record<string, string[]> = {};
      for (const a of agents) feeds[a.id] = s.feeds[a.id] ?? [];
      const selectedId = agents.some((a) => a.id === s.selectedId)
        ? s.selectedId
        : (agents[0]?.id ?? null);
      persistAgents(agents, selectedId);
      persistRestorable(restorableAgents);
      return withActive(s, { agents, feeds, selectedId, restorableAgents });
    }),
  setAddAgentOpen: (open) => set({ addAgentOpen: open }),
  setFullscreen: (id) => set({ fullscreenAgentId: id }),
  setFullscreenFile: (path) => set({ fullscreenFilePath: path }),
  setSidebarWidth: (px) => {
    const clamped = Math.min(1200, Math.max(320, Math.round(px)));
    try { window.localStorage.setItem(LS_SIDEBAR_WIDTH, String(clamped)); } catch { /* noop */ }
    set({ sidebarWidth: clamped });
  },
  setSidebarTab: (tab) => {
    try { window.localStorage.setItem(LS_SIDEBAR_TAB, tab); } catch { /* noop */ }
    set({ sidebarTab: tab });
  }
}));

export function selectedAgent(s: State): Agent | undefined {
  return s.agents.find(a => a.id === s.selectedId);
}

/** The in-view team's slice. The flat State fields mirror this, but a few callers
 *  (and FE-2's routing) want the slice object directly. Falls back to an empty
 *  slice if the active id is somehow unknown. */
export function activeSlice(s: State): TeamSlice {
  return s.teams[s.activeTeamId] ?? emptySlice();
}

/** Summary for the active team (id/name/badges), or a default stand-in. */
export function activeTeam(s: State): TeamSummary {
  return s.teamList.find((t) => t.id === s.activeTeamId)
    ?? { id: s.activeTeamId, name: s.activeTeamId, createdAt: 0, godId: 'god', running: true, agentCount: 0 };
}

/** Every (teamId, agent) pair across ALL teams — the iteration basis for the
 *  background-aware loops (god bootstrap, inbox-wake, queue drain). Parallel
 *  teams stay live, so these loops must service off-screen teams too. */
export function teamAgentEntries(s: State): Array<{ teamId: string; agent: Agent }> {
  const out: Array<{ teamId: string; agent: Agent }> = [];
  for (const [teamId, slice] of Object.entries(s.teams)) {
    for (const a of slice.agents) out.push({ teamId, agent: a });
  }
  return out;
}

/** Kill an agent's PTY and re-spawn it with the SAME agent id (so its memory,
 *  inbox and registry entry reattach), applying an optional model override.
 *  Shared by the PROMPT and CONFIG tabs so the respawn flow lives in one place —
 *  mirrors CommandCenterPanel.restartWithModel. The newly-persisted operator
 *  prompt / registry meta are read from disk by the main process at spawn, so a
 *  respawn is all it takes to apply them.
 *
 *  Pass `model: undefined` to keep the agent's current model. The store's
 *  updateAgent is applied via the passed setter so callers don't import the hook
 *  twice. Returns { ok } so callers can surface failures. */
export async function respawnAgent(
  agent: Agent,
  opts?: { model?: string | undefined; updateModel?: boolean }
): Promise<{ ok: boolean; error?: string }> {
  if (!agent.ptyId) return { ok: false, error: 'agent has no live PTY' };
  const updateAgent = useStore.getState().updateAgent;
  try {
    // Lazy import to avoid a static cycle (config.ts → store.ts is fine, but keep
    // the dispose import local to the renderer-component graph this helper serves).
    const [{ inferAgentProvider, buildSpawnCommand, tokenizeCommand }, { disposeTerminal }] =
      await Promise.all([
        import('@/store/config'),
        import('@/components/terminalPool')
      ]);
    const cfg = await window.cth.getConfig();
    const model = opts?.updateModel ? opts.model : agent.model;
    await window.cth.killPty(agent.ptyId);
    disposeTerminal(agent.ptyId);
    const provider = inferAgentProvider(agent.command, agent.provider);
    const command = buildSpawnCommand(cfg, model, provider);
    const [exe, ...args] = tokenizeCommand(command.trim());
    const hive = agent.isGod
      ? { id: agent.id, name: agent.name, cwd: agent.cwd, provider, isGod: true, role: 'orchestrator (god)' }
      : agent.isAssistant
      ? { id: agent.id, name: agent.name, cwd: agent.cwd, provider, isAssistant: true, role: "orchestrator's prep assistant" }
      : { id: agent.id, name: agent.name, cwd: agent.cwd, provider, role: agent.description };
    // FE-7: a respawn stays in the agent's current (active) team. teamId is added
    // to the spawn options (cast locally — the preload type gains it at backend
    // integration; importing the IPC bridge here would create a store↔ipc cycle).
    const res = await window.cth.spawnPty({
      id: agent.ptyId, cwd: agent.cwd, command: exe, args, provider, cols: 100, rows: 30, hive,
      teamId: useStore.getState().activeTeamId
    } as unknown as Parameters<typeof window.cth.spawnPty>[0]);
    if (res.ok) {
      updateAgent(agent.id, {
        command: command.trim(),
        provider,
        ...(opts?.updateModel ? { model } : {}),
        status: 'idle',
        action: 'restarting…'
      });
    }
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
