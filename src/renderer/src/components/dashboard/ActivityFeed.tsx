import { useStore } from '@/store/store';
import { PixelPanel } from '@/components/PixelPanel';
import { useHiveMessages, type FeedMessage, type MessageAct } from '@/hooks/useHiveMessages';

/** Short human verb for a routed message act. */
const ACT_VERB: Record<MessageAct, string> = {
  request: 'asked',
  inform: 'informed',
  propose: 'proposed to',
  query: 'queried',
  agree: 'agreed with',
  refuse: 'declined',
  done: 'finished for'
};

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/**
 * Live activity feed, newest first: each routed hive message ("X asked Y …")
 * plus the recipient framing for human escalations. Fed by `useHiveMessages`
 * (the old flying-envelope data). Agent ids are resolved to names from the
 * store where possible.
 */
export function ActivityFeed() {
  const messages = useHiveMessages();
  const agents = useStore((s) => s.agents);

  const nameFor = (id: string): string => {
    if (id === 'human') return 'You';
    return agents.find((a) => a.id === id)?.name ?? id;
  };

  const describe = (m: FeedMessage): string => {
    const verb = ACT_VERB[m.act] ?? 'messaged';
    const to = m.needsHuman
      ? 'You'
      : (m.targets.length ? m.targets.map(nameFor).join(', ') : 'the team');
    return `${nameFor(m.from)} ${verb} ${to}`;
  };

  return (
    <PixelPanel title="ACTIVITY" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {messages.length === 0 ? (
        <div style={{ padding: '8px 2px', color: 'var(--cth-ink-500)', fontSize: 'var(--cth-text-body-sm)' }}>
          No activity yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', minHeight: 0 }}>
          {messages.map((m) => (
            <div
              key={m.id}
              style={{
                padding: 8,
                background: m.needsHuman ? 'var(--cth-lilac-light)' : 'var(--cth-cream-200)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                borderRadius: 4
              }}
            >
              <div style={{
                display: 'flex', justifyContent: 'space-between', gap: 8,
                fontSize: 'var(--cth-text-body-sm)', color: 'var(--cth-ink-900)'
              }}>
                <span style={{ fontWeight: 600 }}>{describe(m)}</span>
                <span style={{ color: 'var(--cth-ink-500)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  {timeAgo(m.ts)}
                </span>
              </div>
              {m.subject && (
                <div style={{
                  marginTop: 2,
                  fontSize: 'var(--cth-text-body-sm)', color: 'var(--cth-ink-500)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                }}>
                  {m.subject}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </PixelPanel>
  );
}
