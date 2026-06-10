import { useStore, type Agent } from '@/store/store';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelButton } from '@/components/PixelButton';
import { Avatar } from '@/components/Avatar';
import { useHiveTasks, useTeammateTasks, type DashboardTask, type TaskStatus } from '@/hooks/useHiveTasks';

/** Column order + presentation. Colors reuse the status taxonomy semantics:
 *  blocked = needs attention (coral), done = success (mint). */
const COLUMNS: Array<{ status: TaskStatus; label: string; accent: string }> = [
  { status: 'todo', label: 'To do', accent: 'var(--cth-ink-300)' },
  { status: 'doing', label: 'Doing', accent: 'var(--cth-sky)' },
  { status: 'blocked', label: 'Blocked', accent: 'var(--cth-coral)' },
  { status: 'done', label: 'Done', accent: 'var(--cth-mint)' }
];

/** Live status → dot color. Lets a "doing" card read as actively-working (sky),
 *  warming-up (lemon), blocked (coral), done (mint), or idle/gone (muted) at a
 *  glance — the same status taxonomy the roster badges use. */
const STATUS_DOT: Record<string, string> = {
  working: 'var(--cth-sky)', thinking: 'var(--cth-sky)',
  compacting: 'var(--cth-lemon)', looping: 'var(--cth-lemon)', waiting: 'var(--cth-lemon)',
  blocked: 'var(--cth-coral)', success: 'var(--cth-mint)',
  idle: 'var(--cth-ink-300)', ghost: 'var(--cth-ink-300)', gone: 'var(--cth-ink-300)'
};
function statusDot(status?: string): string {
  return (status && STATUS_DOT[status]) || 'var(--cth-ink-300)';
}

/**
 * Compact "who's on this" widget for a task card: the assignee's avatar + a live
 * status dot + name. The assignee is the agent the orchestrator dispatched the
 * task to (and never clears), so this answers "who is doing it" for a `doing`
 * card and "who did it" for a `done` one — using data already maintained, no new
 * per-task field. `agent` is undefined for a teammate's board (their roster isn't
 * in the local store): we then show the raw id with no live status dot.
 */
function AgentChip({ agent, idFallback }: { agent?: Agent; idFallback: string }) {
  const name = agent?.name ?? idFallback;
  return (
    <span
      title={agent ? `${name} · ${agent.status}` : name}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0, maxWidth: '100%' }}
    >
      <Avatar name={name} accent={agent?.accent ?? 'sky'} size={16} />
      {agent && (
        <span style={{
          width: 6, height: 6, flexShrink: 0, borderRadius: '50%',
          background: statusDot(agent.status), boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)'
        }} />
      )}
      <span style={{
        fontSize: 'var(--cth-text-body-sm)', color: 'var(--cth-ink-700, var(--cth-ink-500))',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
      }}>{name}</span>
    </span>
  );
}

/**
 * Kanban view of the hive ledger. Driven by the shared view toggle (store
 * `viewedOwner`): your own board (local hive's tasks.json via useHiveTasks) by
 * default, or a teammate's board fetched READ-ONLY from Supabase when one is
 * selected — the same selection that switches the roster, so they move together.
 * Your local board is never polluted with a teammate's tasks. The header / cards
 * open the local Command Center tasks tab only while viewing your own board.
 */
export function TaskBoard() {
  const viewedOwner = useStore((s) => s.viewedOwner);
  const mine = useHiveTasks();
  const teammate = useTeammateTasks(viewedOwner ? viewedOwner.machineId : null);
  const { grouped, loaded } = viewedOwner ? teammate : mine;
  const viewingTeammate = viewedOwner !== null;

  const agents = useStore((s) => s.agents);
  const requestCommandCenterTab = useStore((s) => s.requestCommandCenterTab);
  // Only your own board navigates to the (local) Command Center tasks tab.
  const openTasks = viewingTeammate ? undefined : () => requestCommandCenterTab('tasks');

  return (
    <PixelPanel
      title="TASKS"
      style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 8 }}>
        {viewingTeammate ? (
          <span style={{ fontSize: 'var(--cth-text-body-sm)', color: 'var(--cth-ink-300)' }}>read-only</span>
        ) : (
          <PixelButton size="sm" variant="ghost" onClick={openTasks}>Open tasks →</PixelButton>
        )}
      </div>
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8,
        flex: 1, minHeight: 0
      }}>
        {COLUMNS.map((col) => {
          const items = grouped[col.status];
          return (
            <div key={col.status} style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <button
                onClick={openTasks}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
                  border: 'none', cursor: viewingTeammate ? 'default' : 'pointer', textAlign: 'left',
                  padding: '4px 8px',
                  background: 'var(--cth-cream-200)',
                  boxShadow: `inset 0 -2px 0 ${col.accent}`,
                  fontFamily: 'var(--cth-font-display)',
                  fontSize: 'var(--cth-text-display-sm)',
                  color: 'var(--cth-ink-900)'
                }}
              >
                <span>{col.label}</span>
                <span style={{ color: 'var(--cth-ink-500)' }}>{items.length}</span>
              </button>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', marginTop: 6, minHeight: 0 }}>
                {loaded && items.length === 0 ? (
                  <div style={{ color: 'var(--cth-ink-300)', fontSize: 'var(--cth-text-body-sm)', padding: '2px 4px' }}>—</div>
                ) : (
                  items.map((t: DashboardTask) => (
                    <button
                      key={t.id}
                      onClick={openTasks}
                      title={t.title}
                      style={{
                        textAlign: 'left', cursor: viewingTeammate ? 'default' : 'pointer', border: 'none',
                        padding: 6, borderRadius: 4,
                        background: 'var(--cth-cream-100)',
                        boxShadow: `inset 0 0 0 1px var(--cth-ink-100), inset 3px 0 0 ${col.accent}`
                      }}
                    >
                      <div style={{
                        fontSize: 'var(--cth-text-body-sm)', lineHeight: '16px', color: 'var(--cth-ink-900)',
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden'
                      }}>
                        {t.title}
                      </div>
                      {(t.assignee || t.needsHuman) && (
                        <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          {t.assignee && (
                            <AgentChip agent={agents.find((a) => a.id === t.assignee)} idFallback={t.assignee} />
                          )}
                          {t.needsHuman && (
                            <span style={{
                              marginLeft: 'auto', flexShrink: 0,
                              fontSize: 'var(--cth-text-body-sm)', color: 'var(--cth-coral)', whiteSpace: 'nowrap'
                            }}>needs you</span>
                          )}
                        </div>
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </PixelPanel>
  );
}
