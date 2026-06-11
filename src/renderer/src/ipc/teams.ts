/**
 * The single renderer-side boundary to the multi-team IPC surface.
 *
 * Why this module exists: the team-aware preload methods (teamsList, cloneTeam,
 * onTeamsEvent) and the `teamId` arg added to existing query/spawn channels live
 * on backend's preload branch (feat/mt-be-foundation). On THIS branch the preload
 * TYPES don't include them yet, and we must not edit src/preload (backend owns it
 * — editing would conflict at integration). So every access to the new surface is
 * funnelled through here and cast at this one boundary. At integration, the casts
 * line up with the real CthApi and become no-ops.
 *
 * God's contract named the bridge `window.api`; the app actually exposes it as
 * `window.cth` (the preload object is literally named `api` but contextBridge-
 * exposed as `cth`). We resolve either, defensively.
 */
import type { TeamSummary, CloneTeamResult, TeamEvent } from '@shared/teams';
import { DEFAULT_TEAM_ID } from '@/store/store';

/** The new/team-aware methods backend added to the preload bridge. Optional so
 *  this branch (whose preload lacks them) still type-checks and runs. */
interface TeamAwareBridge {
  teamsList?: () => Promise<TeamSummary[]>;
  cloneTeam?: (sourceTeamId: string, newName: string) => Promise<CloneTeamResult>;
  onTeamsEvent?: (cb: (ev: TeamEvent) => void) => () => void;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The runtime bridge, typed loosely for the team-aware extensions. The single
 *  place `any` is tolerated — every other module imports the typed helpers below. */
function bridge(): TeamAwareBridge & Record<string, any> {
  const w = window as unknown as { cth?: any; api?: any };
  return (w.cth ?? w.api ?? {}) as TeamAwareBridge & Record<string, any>;
}

/** List all local teams. Falls back to a lone default team if the backend method
 *  isn't present yet (pre-integration / older session). */
export async function teamsList(): Promise<TeamSummary[]> {
  try {
    const fn = bridge().teamsList;
    if (fn) return await fn();
  } catch { /* fall through */ }
  return [{ id: DEFAULT_TEAM_ID, name: 'Default', createdAt: 0, godId: 'god', running: true, agentCount: 0 }];
}

/** Clone a team (configs-only, fresh start). Returns a typed result; surfaces a
 *  clear error if the backend method isn't wired yet. */
export async function cloneTeam(sourceTeamId: string, newName: string): Promise<CloneTeamResult> {
  const fn = bridge().cloneTeam;
  if (!fn) return { ok: false, error: 'cloneTeam is unavailable (backend not integrated yet)' };
  try {
    return await fn(sourceTeamId, newName);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Subscribe to team lifecycle/status events. Returns an unsubscribe fn (a no-op
 *  if the channel isn't available this session). */
export function onTeamsEvent(cb: (ev: TeamEvent) => void): () => void {
  const fn = bridge().onTeamsEvent;
  if (!fn) return () => { /* noop */ };
  try {
    return fn(cb);
  } catch {
    return () => { /* noop */ };
  }
}

/** Read the `teamId` off any teamId-stamped push-event payload, defaulting to the
 *  default team when a (pre-integration) event arrives without the stamp. This is
 *  what lets the renderer demux a single global event stream by team. */
export function teamIdOf(payload: unknown, fallback: string = DEFAULT_TEAM_ID): string {
  if (payload && typeof payload === 'object') {
    const t = (payload as { teamId?: unknown }).teamId;
    if (typeof t === 'string' && t) return t;
  }
  return fallback;
}

/** Deterministic PTY id for a team's god (orchestrator). The default team keeps
 *  the legacy `pty-god` (so restored sessions reattach); other teams are scoped so
 *  two gods never collide in the main process's ptyId-keyed maps. */
export function godPtyId(teamId: string): string {
  return teamId === DEFAULT_TEAM_ID ? 'pty-god' : `pty-${teamId}-god`;
}

/** Deterministic PTY id for a team's WORKER (non-god) agent. The default team
 *  keeps the legacy `pty-<agentId>` (so restored sessions + AddAgentModal-spawned
 *  workers reattach with no regression); other teams are scoped by teamId so a
 *  cloned roster — which reuses the SOURCE team's agent ids — can't collide with
 *  the source's PTYs in the main process's global, ptyId-keyed session map
 *  (ptyManager rejects a duplicate id). Mirrors `godPtyId`. */
export function workerPtyId(teamId: string, agentId: string): string {
  return teamId === DEFAULT_TEAM_ID ? `pty-${agentId}` : `pty-${teamId}-${agentId}`;
}

/** A team's on-disk base path, used as the god's cwd when spawning. Derived from
 *  the architect's storage layout (§2): default team at <harnessHome>, other teams
 *  at <harnessHome>/teams/<id>. NOTE: integration risk — if backend resolves the
 *  team home from the teamId arg instead, this cwd is harmless/overridden. */
export function teamCwd(harnessHome: string, teamId: string): string {
  return teamId === DEFAULT_TEAM_ID ? harnessHome : `${harnessHome}/teams/${teamId}`;
}

/** Spawn a PTY scoped to a team — threads `teamId` into the spawn options so the
 *  main process routes ensureAgent/env/teardown to the right TeamRuntime. The
 *  options shape is the existing SpawnPtyOptions + teamId (cast at the boundary). */
export function spawnPtyForTeam(
  opts: Record<string, unknown>,
  teamId: string
): Promise<{ ok: boolean; error?: string }> {
  return bridge().spawnPty({ ...opts, teamId });
}

/** Per-team query passthroughs — `teamId` as the trailing optional arg per the
 *  contract. Cast at the boundary; identical at runtime to the typed cth calls. */
export function hiveTasksFor(teamId: string): Promise<unknown> {
  return bridge().hiveTasks(teamId);
}
export function hiveInboxFor(agentId: string, teamId: string): Promise<Array<{ id: string }>> {
  return bridge().hiveInbox(agentId, teamId);
}
export function telemetrySnapshotFor(teamId: string): Promise<unknown> {
  return bridge().telemetrySnapshot?.(teamId);
}
export function telemetrySpansFor(agentId: string, teamId: string): Promise<unknown> {
  return bridge().telemetrySpans?.(agentId, teamId);
}
/* eslint-enable @typescript-eslint/no-explicit-any */
