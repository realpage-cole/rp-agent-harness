import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelButton } from '@/components/PixelButton';
import { useHiveTasks, useTeammateTasks, type DashboardTask, type TaskStatus } from '@/hooks/useHiveTasks';

/** Column order + presentation. Colors reuse the status taxonomy semantics:
 *  blocked = needs attention (coral), done = success (mint). */
const COLUMNS: Array<{ status: TaskStatus; label: string; accent: string }> = [
  { status: 'todo', label: 'To do', accent: 'var(--cth-ink-300)' },
  { status: 'doing', label: 'Doing', accent: 'var(--cth-sky)' },
  { status: 'blocked', label: 'Blocked', accent: 'var(--cth-coral)' },
  { status: 'done', label: 'Done', accent: 'var(--cth-mint)' }
];

/** A teammate board option from the picker (machine id + friendly owner label). */
interface BoardOption { machineId: string; ownerLabel: string | null }

/**
 * Kanban view of the hive ledger. Defaults to YOUR board (the local hive's
 * tasks.json via useHiveTasks). A board picker lets you switch to a teammate's
 * board — fetched read-only from Supabase on demand (your local board is never
 * polluted with their tasks). The header / cards open the local Command Center
 * tasks tab only while viewing your own board.
 */
export function TaskBoard() {
  // null = my board; otherwise a teammate's machine id.
  const [owner, setOwner] = useState<string | null>(null);
  const [boards, setBoards] = useState<BoardOption[]>([]);

  const mine = useHiveTasks();
  const teammate = useTeammateTasks(owner);
  const { grouped, loaded } = owner ? teammate : mine;
  const viewingTeammate = owner !== null;

  const agents = useStore((s) => s.agents);
  const requestCommandCenterTab = useStore((s) => s.requestCommandCenterTab);
  // Only the local board navigates to the (local) Command Center tasks tab.
  const openTasks = viewingTeammate ? undefined : () => requestCommandCenterTab('tasks');

  const nameFor = (id?: string): string | undefined =>
    id ? (agents.find((a) => a.id === id)?.name ?? id) : undefined;

  // Refresh the list of teammate boards (everyone in the workspace but you).
  // Best-effort + graceful: when sync is off / signed out it returns [] and the
  // picker just shows "My board".
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const list = await window.cth.syncListTaskBoards();
        if (!cancelled) setBoards(Array.isArray(list) ? list : []);
      } catch { /* keep the last list */ }
    };
    void load();
    const handle = setInterval(() => { void load(); }, 20000);
    return () => { cancelled = true; clearInterval(handle); };
  }, []);

  // If the currently-viewed teammate disappears from the list, fall back to mine.
  useEffect(() => {
    if (owner && !boards.some((b) => b.machineId === owner)) setOwner(null);
  }, [boards, owner]);

  const ownerLabel = (b: BoardOption): string => b.ownerLabel || `teammate ${b.machineId.slice(0, 6)}`;

  return (
    <PixelPanel
      title="TASKS"
      style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--cth-text-body-sm)', color: 'var(--cth-ink-500)' }}>
          Board
          <select
            value={owner ?? 'me'}
            onChange={(e) => setOwner(e.target.value === 'me' ? null : e.target.value)}
            style={{
              fontSize: 'var(--cth-text-body-sm)', color: 'var(--cth-ink-900)',
              background: 'var(--cth-cream-100)', border: '1px solid var(--cth-ink-100)',
              borderRadius: 4, padding: '2px 6px', maxWidth: 200
            }}
          >
            <option value="me">My board</option>
            {boards.map((b) => (
              <option key={b.machineId} value={b.machineId}>{ownerLabel(b)}</option>
            ))}
          </select>
        </label>
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
