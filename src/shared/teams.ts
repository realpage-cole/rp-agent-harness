/**
 * Multi-team shared contract types — the BE/FE seam.
 *
 * MIRRORS the canonical file on backend's branch (feat/mt-be-foundation). The
 * shapes here are copied VERBATIM from god's pinned contract so that, when the
 * branches integrate, this file collapses cleanly onto backend's identical copy.
 * Do NOT diverge these shapes without coordinating through god — they are the
 * boundary every per-team query/event is built against.
 */

/** A team as listed for the selector / dashboard. */
export interface TeamSummary {
  id: string;
  name: string;
  createdAt: number;
  godId: string;
  /** runtime is live in the main process (parallel teams are always running). */
  running: boolean;
  /** active (non-archived) agent count. */
  agentCount: number;
}

/** Result of cloning a team (configs-only, fresh start). */
export interface CloneTeamResult {
  ok: boolean;
  teamId?: string;
  error?: string;
}

/** Pushed on the teams:event channel so the renderer can keep its team list and
 *  per-team status badges current. */
export type TeamEvent =
  | { kind: 'created'; teamId: string; summary: TeamSummary }
  | { kind: 'status'; teamId: string; running: boolean; agentCount: number };
