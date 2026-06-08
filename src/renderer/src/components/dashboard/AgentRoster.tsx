import { useStore } from '@/store/store';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelBadge } from '@/components/PixelBadge';
import { Avatar } from '@/components/Avatar';

/** Current-action line for a card. Idle agents show nothing (the badge already
 *  says "idle"); otherwise prefer the live action, then the last prompt. */
function actionLine(status: string, action: string, lastPrompt?: string): string {
  if (status === 'idle') return '';
  const a = (action || '').trim();
  if (a) return a;
  return (lastPrompt || '').trim();
}

/**
 * The team roster: one card per agent (Avatar + name + status badge + current
 * action). Clicking a card selects that agent (drives the right sidebar). Reads
 * `agents` straight from the store — the same data the office floor's avatars
 * rendered from.
 */
export function AgentRoster() {
  const agents = useStore((s) => s.agents);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);

  return (
    <PixelPanel title="TEAM" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {agents.length === 0 ? (
        <div style={{ padding: '8px 2px', color: 'var(--cth-ink-500)', fontSize: 'var(--cth-text-body-sm)' }}>
          No agents yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', minHeight: 0 }}>
          {agents.map((a) => {
            const selected = a.id === selectedId;
            const line = actionLine(a.status, a.action, a.lastPrompt);
            return (
              <button
                key={a.id}
                onClick={() => select(a.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  width: '100%', textAlign: 'left', cursor: 'pointer',
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
                    {line || ' '}
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
