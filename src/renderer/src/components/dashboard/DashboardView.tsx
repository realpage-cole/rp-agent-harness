import { useState } from 'react';
import { useStore, activeTeam } from '@/store/store';
import { PixelButton } from '@/components/PixelButton';
import { AgentRoster } from './AgentRoster';
import { ActivityFeed } from './ActivityFeed';
import { TaskBoard } from './TaskBoard';
import { NotepadBoard } from './NotepadBoard';
import { NeedsYouBanner } from './NeedsYouBanner';
import { HiveViewSelector } from './HiveViewSelector';
import { TeamSelector } from './TeamSelector';
import { CloneTeamModal } from './CloneTeamModal';

/**
 * The main pane: a modern dashboard composing the roster, task board, activity
 * feed, the "needs you" banner, and quick-nav into the Command Center tabs
 * (tasks / schedules / human). This is the sole replacement for the deleted
 * office floor; all four real data bindings (tasks, human queue, messages,
 * agent status) flow through the composed pieces and their hooks.
 */
export function DashboardView() {
  const requestCommandCenterTab = useStore((s) => s.requestCommandCenterTab);
  const centerView = useStore((s) => s.centerView);
  const setCenterView = useStore((s) => s.setCenterView);
  const team = useStore(activeTeam);
  const [cloneOpen, setCloneOpen] = useState(false);

  return (
    <div style={{
      position: 'relative', height: '100%', minHeight: 0,
      display: 'flex', flexDirection: 'column', gap: 12,
      padding: 16, boxSizing: 'border-box', overflow: 'hidden'
    }}>
      {/* Quick navigation into the Command Center — the dashboard's equivalent
          of clicking office scene props (calendar/boards/ASK ME). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <span style={{
          fontFamily: 'var(--cth-font-display)',
          fontSize: 'var(--cth-text-display-md)',
          color: 'var(--cth-ink-900)'
        }}>HIVE</span>
        {/* Local team switcher — swaps which of your parallel teams is in view.
            Distinct from HiveViewSelector (read-only Supabase teammate viewing).
            Renders nothing until a second team exists. */}
        <TeamSelector />
        {/* Clone the active team into a fresh parallel team (FE-5). */}
        <button
          className="cth-chip"
          onClick={() => setCloneOpen(true)}
          title={`Clone ${team.name} into a new team`}
          style={{
            padding: '4px 10px',
            background: 'var(--cth-cream-50)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
            fontFamily: 'var(--cth-font-ui)', fontSize: 13,
            color: 'var(--cth-ink-700)', cursor: 'pointer', border: 'none'
          }}
        >
          + Clone team
        </button>
        {/* Unified view toggle — switches roster + kanban between your hive and a
            teammate's (read-only) together. */}
        <HiveViewSelector />
        {/* Compact center-panel surface toggle: the kanban vs the shared Notepad. */}
        <div style={{ display: 'flex', gap: 4 }}>
          {(['kanban', 'notepad'] as const).map((v) => (
            <button
              key={v}
              className="cth-chip"
              data-active={centerView === v}
              onClick={() => setCenterView(v)}
              style={{
                padding: '4px 10px',
                background: centerView === v ? 'var(--cth-sky-light)' : 'var(--cth-cream-50)',
                boxShadow: centerView === v
                  ? 'inset 0 0 0 1px var(--cth-sky)'
                  : 'inset 0 0 0 1px var(--cth-ink-100)',
                fontFamily: 'var(--cth-font-ui)', fontSize: 13,
                fontWeight: centerView === v ? 600 : 400,
                color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none',
                textTransform: 'capitalize'
              }}
            >
              {v === 'kanban' ? 'Kanban' : 'Notepad'}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <PixelButton size="sm" variant="secondary" onClick={() => requestCommandCenterTab('tasks')}>Tasks</PixelButton>
          <PixelButton size="sm" variant="secondary" onClick={() => requestCommandCenterTab('schedules')}>Schedules</PixelButton>
          <PixelButton size="sm" variant="secondary" onClick={() => requestCommandCenterTab('human')}>Needs you</PixelButton>
        </div>
      </div>

      <NeedsYouBanner />

      <div style={{
        flex: 1, minHeight: 0,
        display: 'grid',
        gridTemplateColumns: 'minmax(240px, 320px) 1fr minmax(260px, 360px)',
        gap: 12
      }}>
        <AgentRoster />
        {centerView === 'notepad' ? <NotepadBoard /> : <TaskBoard />}
        <ActivityFeed />
      </div>

      {cloneOpen && (
        <CloneTeamModal
          sourceTeamId={team.id}
          sourceName={team.name}
          onClose={() => setCloneOpen(false)}
        />
      )}
    </div>
  );
}
