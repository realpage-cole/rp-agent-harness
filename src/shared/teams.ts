/**
 * Shared multi-team IPC types — the BE/FE seam (findings-MT-1 §6.1).
 *
 * Imported by the main process (emit + handlers), the preload bridge, and the
 * renderer (store + TeamSelector), so all three agree on one shape.
 */

/** One team as the renderer sees it. `running` reflects whether the team's
 *  services are live; `agentCount` is its non-archived roster size. */
export interface TeamSummary {
  id: string;
  name: string;
  createdAt: number;
  godId: string;
  running: boolean;
  agentCount: number;
}

/** Result of teams:clone — the new team's id, or an error. */
export interface CloneTeamResult {
  ok: boolean;
  teamId?: string;
  error?: string;
}

/** Push event on `teams:event`. NOT teamId-stamped the way per-team data events
 *  are — these are ABOUT the team set, so the payload names the team directly.
 *  - 'created': a new team came online (carries the full summary so the renderer
 *    can add + switch to it).
 *  - 'status': a team's running/agentCount changed (so badges stay live).
 *  - 'removed': a team was deleted (so the renderer drops it + switches away). */
export type TeamEvent =
  | { kind: 'created'; teamId: string; summary: TeamSummary }
  | { kind: 'status'; teamId: string; running: boolean; agentCount: number }
  | { kind: 'removed'; teamId: string };
