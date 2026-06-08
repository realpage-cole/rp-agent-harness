import { useStore } from '@/store/store';
import { PixelButton } from '@/components/PixelButton';
import { AgentRoster } from './AgentRoster';
import { ActivityFeed } from './ActivityFeed';
import { TaskBoard } from './TaskBoard';
import { NeedsYouBanner } from './NeedsYouBanner';

/**
 * The main pane: a modern dashboard composing the roster, task board, activity
 * feed, the "needs you" banner, and quick-nav into the Command Center tabs
 * (tasks / schedules / human). This is the sole replacement for the deleted
 * office floor; all four real data bindings (tasks, human queue, messages,
 * agent status) flow through the composed pieces and their hooks.
 */
export function DashboardView() {
  const requestCommandCenterTab = useStore((s) => s.requestCommandCenterTab);

  return (
    <div style={{
      position: 'relative', height: '100%', minHeight: 0,
      display: 'flex', flexDirection: 'column', gap: 12,
      padding: 16, boxSizing: 'border-box', overflow: 'hidden'
    }}>
      {/* Quick navigation into the Command Center — the dashboard's equivalent
          of clicking office scene props (calendar/boards/ASK ME). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{
          fontFamily: 'var(--cth-font-display)',
          fontSize: 'var(--cth-text-display-md)',
          color: 'var(--cth-ink-900)', marginRight: 'auto'
        }}>HIVE</span>
        <PixelButton size="sm" variant="secondary" onClick={() => requestCommandCenterTab('tasks')}>Tasks</PixelButton>
        <PixelButton size="sm" variant="secondary" onClick={() => requestCommandCenterTab('schedules')}>Schedules</PixelButton>
        <PixelButton size="sm" variant="secondary" onClick={() => requestCommandCenterTab('human')}>Needs you</PixelButton>
      </div>

      <NeedsYouBanner />

      <div style={{
        flex: 1, minHeight: 0,
        display: 'grid',
        gridTemplateColumns: 'minmax(240px, 320px) 1fr minmax(260px, 360px)',
        gap: 12
      }}>
        <AgentRoster />
        <TaskBoard />
        <ActivityFeed />
      </div>
    </div>
  );
}
