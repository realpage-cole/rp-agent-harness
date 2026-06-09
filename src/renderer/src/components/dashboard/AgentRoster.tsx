import { useStore } from '@/store/store';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelBadge, type StatusKind } from '@/components/PixelBadge';
import { Avatar } from '@/components/Avatar';
import { useTeammateAgents } from '@/hooks/useHiveView';
import type { AccentColorName } from '@/design/tokens';

/** Current-action line for a card. Idle agents show nothing (the badge already
 *  says "idle"); otherwise prefer the live action, then the last prompt. */
function actionLine(status: string, action: string, lastPrompt?: string): string {
  if (status === 'idle') return '';
  const a = (action || '').trim();
  if (a) return a;
  return (lastPrompt || '').trim();
}

const STATUS_KINDS = new Set<StatusKind>([
  'idle', 'thinking', 'working', 'waiting', 'blocked', 'success', 'ghost', 'compacting', 'looping'
]);
/** Coerce a possibly-unknown synced status onto the badge taxonomy ('gone' is a
 *  hive status with no badge color → show it as 'ghost'). */
function toStatusKind(s: string): StatusKind {
  if (STATUS_KINDS.has(s as StatusKind)) return s as StatusKind;
  return s === 'gone' ? 'ghost' : 'idle';
}

const ACCENTS: AccentColorName[] = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'];
/** Stable accent for a teammate's agent (which has no synced accent) so the
 *  read-only roster still looks distinct + consistent across polls. */
function accentFor(id: string): AccentColorName {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}

/** A roster card, unified across your local agents (store, selectable) and a
 *  teammate's read-only roster (synced; no action/accent). */
interface RosterItem {
  id: string;
  name: string;
  status: StatusKind;
  isGod: boolean;
  accent: AccentColorName;
  action: string;
  selectable: boolean;
}

/**
 * The team roster. By default shows YOUR agents (the store) — selectable, driving
 * the right sidebar. When a teammate is selected in the unified view toggle
 * (store `viewedOwner`), it shows that teammate's roster READ-ONLY instead. One
 * shared selection keeps the roster + kanban in lockstep.
 */
export function AgentRoster() {
  const viewedOwner = useStore((s) => s.viewedOwner);
  const localAgents = useStore((s) => s.agents);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const teammate = useTeammateAgents(viewedOwner ? viewedOwner.machineId : null);

  const viewing = viewedOwner !== null;
  const items: RosterItem[] = viewing
    ? teammate.agents.map((a) => ({
        id: a.id, name: a.name, status: toStatusKind(a.status), isGod: a.isGod,
        accent: accentFor(a.id), action: '', selectable: false
      }))
    : localAgents.map((a) => ({
        id: a.id, name: a.name, status: toStatusKind(a.status), isGod: !!a.isGod,
        accent: a.accent, action: actionLine(a.status, a.action, a.lastPrompt), selectable: true
      }));

  return (
    <PixelPanel title="TEAM" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {items.length === 0 ? (
        <div style={{ padding: '8px 2px', color: 'var(--cth-ink-500)', fontSize: 'var(--cth-text-body-sm)' }}>
          {viewing ? 'This teammate has no agents.' : 'No agents yet.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', minHeight: 0 }}>
          {items.map((a) => {
            const selected = a.selectable && a.id === selectedId;
            return (
              <button
                key={a.id}
                onClick={a.selectable ? () => select(a.id) : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  width: '100%', textAlign: 'left', cursor: a.selectable ? 'pointer' : 'default',
                  padding: 8, border: 'none',
                  background: selected ? 'var(--cth-cream-200)' : 'transparent',
                  boxShadow: selected
                    ? `inset 0 0 0 1px var(--cth-${a.accent})`
                    : 'inset 0 0 0 1px var(--cth-panel-border-color, transparent)'
                }}
              >
                <Avatar name={a.name} accent={a.accent} size={36} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between'
                  }}>
                    <span style={{
                      fontFamily: 'var(--cth-font-display)',
                      fontSize: 'var(--cth-text-display-sm)',
                      lineHeight: 'var(--cth-lh-display-sm)',
                      color: 'var(--cth-ink-900)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                    }}>
                      {a.name}
                      {a.isGod && (
                        <span style={{
                          marginLeft: 6,
                          fontFamily: 'var(--cth-font-display)', fontSize: 8,
                          background: `var(--cth-${a.accent})`, color: 'var(--cth-ink-900)',
                          padding: '1px 5px 0', borderRadius: 3
                        }}>LEAD</span>
                      )}
                    </span>
                    <PixelBadge status={a.status} />
                  </div>
                  <div style={{
                    minHeight: 16,
                    fontSize: 'var(--cth-text-body-sm)', lineHeight: '16px',
                    color: 'var(--cth-ink-500)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                  }}>
                    {a.action || ' '}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </PixelPanel>
  );
}
