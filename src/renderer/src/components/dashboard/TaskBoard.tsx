import { useStore } from '@/store/store';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelButton } from '@/components/PixelButton';
import { useHiveTasks, type DashboardTask, type TaskStatus } from '@/hooks/useHiveTasks';

/** Column order + presentation. Colors reuse the status taxonomy semantics:
 *  blocked = needs attention (coral), done = success (mint). */
const COLUMNS: Array<{ status: TaskStatus; label: string; accent: string }> = [
  { status: 'todo', label: 'To do', accent: 'var(--cth-ink-300)' },
  { status: 'doing', label: 'Doing', accent: 'var(--cth-sky)' },
  { status: 'blocked', label: 'Blocked', accent: 'var(--cth-coral)' },
  { status: 'done', label: 'Done', accent: 'var(--cth-mint)' }
];

/**
 * Kanban view of the hive ledger: todo / doing / blocked / done columns from
 * `useHiveTasks`. The header and any card open the Command Center's tasks tab
 * (via requestCommandCenterTab) — the equivalent of clicking the old office
 * cork boards. Assignee ids are resolved to names from the store.
 */
export function TaskBoard() {
  const { grouped, loaded } = useHiveTasks();
  const agents = useStore((s) => s.agents);
  const requestCommandCenterTab = useStore((s) => s.requestCommandCenterTab);
  const openTasks = () => requestCommandCenterTab('tasks');

  const nameFor = (id?: string): string | undefined =>
    id ? (agents.find((a) => a.id === id)?.name ?? id) : undefined;

  return (
    <PixelPanel
      title="TASKS"
      style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <PixelButton size="sm" variant="ghost" onClick={openTasks}>Open tasks →</PixelButton>
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
                  border: 'none', cursor: 'pointer', textAlign: 'left',
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
                        textAlign: 'left', cursor: 'pointer', border: 'none',
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
                      {(nameFor(t.assignee) || t.needsHuman) && (
                        <div style={{
                          marginTop: 2, fontSize: 'var(--cth-text-body-sm)', color: 'var(--cth-ink-500)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                        }}>
                          {t.needsHuman ? 'needs you' : nameFor(t.assignee)}
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
