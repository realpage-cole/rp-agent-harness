import { useStore, type TeamSummary } from '@/store/store';

/**
 * TeamSelector — switches which LOCAL team is in view (sets `activeTeamId`).
 *
 * DISTINCT from `HiveViewSelector`: that one switches the *read-only Supabase
 * teammate* you're viewing (another machine's hive); this one switches between
 * your own parallel local teams (the multi-team / clone-team epic). Teams run in
 * parallel in the main process — switching here NEVER stops the others, it only
 * swaps which team's slice feeds the dashboard (architect findings §7.7).
 *
 * Each team shows a live-activity badge derived from its store slice (working
 * agent count) plus a running dot. Until the main process reports the full team
 * list + per-team status (FE-2 / `teams:list`), this lists whatever teams the
 * store knows about — at minimum the default team.
 */

/** Count of agents currently doing work (thinking/working) in a team's slice —
 *  a lightweight live-activity proxy that doesn't need any new IPC. */
function liveCount(teams: Record<string, { agents: { status: string }[] }>, teamId: string): number {
  const slice = teams[teamId];
  if (!slice) return 0;
  return slice.agents.filter((a) => a.status === 'working' || a.status === 'thinking').length;
}

export function TeamSelector() {
  const teamList = useStore((s) => s.teamList);
  const activeTeamId = useStore((s) => s.activeTeamId);
  const teams = useStore((s) => s.teams);
  const setActiveTeam = useStore((s) => s.setActiveTeam);

  // Single-team installs: nothing to switch between. Keep the chrome quiet until
  // a second team exists (e.g. after a clone — FE-5).
  if (teamList.length <= 1) return null;

  const labelFor = (t: TeamSummary): string => t.name || t.id;

  return (
    <div
      role="tablist"
      aria-label="Teams"
      style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
    >
      <span style={{ fontSize: 'var(--cth-text-body-sm)', color: 'var(--cth-ink-500)' }}>Team</span>
      {teamList.map((t) => {
        const active = t.id === activeTeamId;
        const busy = liveCount(teams, t.id);
        const agentCount = t.agentCount ?? teams[t.id]?.agents.length ?? 0;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={active}
            title={`${labelFor(t)} — ${agentCount} agent${agentCount === 1 ? '' : 's'}${busy ? `, ${busy} active` : ''}`}
            onClick={() => setActiveTeam(t.id)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '3px 10px 1px',
              background: active ? 'var(--cth-sky-light)' : 'var(--cth-cream-100)',
              boxShadow: active
                ? 'inset 0 0 0 2px var(--cth-ink-900)'
                : 'inset 0 0 0 1px var(--cth-ink-700)',
              fontFamily: 'var(--cth-font-ui)', fontSize: 13,
              color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
            }}
          >
            {/* running/activity dot: filled = work in flight, hollow ring = live but idle */}
            <span
              aria-hidden
              style={{
                width: 8, height: 8,
                background: busy ? 'var(--cth-status-working)' : 'transparent',
                boxShadow: busy
                  ? 'inset 0 0 0 1px var(--cth-ink-900)'
                  : 'inset 0 0 0 1px var(--cth-ink-300)'
              }}
            />
            {labelFor(t)}
            {busy > 0 && (
              <span style={{ color: 'var(--cth-ink-500)', fontSize: 11 }}>{busy}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
