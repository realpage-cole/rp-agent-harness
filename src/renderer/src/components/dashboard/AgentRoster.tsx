import { useStore } from '@/store/store';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelBadge, type StatusKind } from '@/components/PixelBadge';
import { Avatar } from '@/components/Avatar';
import { useTeammateAgents } from '@/hooks/useHiveView';
import { useCostTotals, type CostTotals } from '@/hooks/useCostTotals';
import type { AccentColorName } from '@/design/tokens';

/** Humanize a token count: 950 / 12k / 1.2M. */
function fmtTokens(n: number): string {
  if (!n || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  const m = n / 1_000_000;
  return `${m >= 100 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, '')}M`;
}

/** Humanize USD: $4.10 (always 2dp; $0.00 for nothing). */
function fmtUsd(n: number): string {
  return `$${(n || 0).toFixed(2)}`;
}

/** Drop the provider prefix + bracketed suffixes for a compact model label
 *  (e.g. 'claude-sonnet-4-6[1m]' -> 'sonnet-4-6'). */
function shortModel(model: string | null | undefined): string {
  if (!model) return '';
  return model.replace(/^claude-/, '').replace(/\[.*?\]/g, '').trim();
}

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
  /** Display model for this card — store model first, ledger model as fallback.
   *  '' when unknown. */
  model: string;
  /** Session tokens for this agent (live, 0 if none / teammate). */
  tokens: number;
  /** Session USD for this agent. null = omit the cost line (teammate cards —
   *  cost is this-machine only). */
  usd: number | null;
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
  const costs = useCostTotals();

  const viewing = viewedOwner !== null;
  const items: RosterItem[] = viewing
    ? teammate.agents.map((a) => ({
        id: a.id, name: a.name, status: toStatusKind(a.status), isGod: a.isGod,
        accent: accentFor(a.id), action: '', selectable: false,
        // Cost is this-machine only — omit on read-only teammate cards.
        model: '', tokens: 0, usd: null
      }))
    : localAgents.map((a) => {
        const c = costs.byAgent[a.id];
        return {
          id: a.id, name: a.name, status: toStatusKind(a.status), isGod: !!a.isGod,
          accent: a.accent, action: actionLine(a.status, a.action, a.lastPrompt), selectable: true,
          model: shortModel(a.model) || shortModel(c?.model),
          tokens: c?.tokens ?? 0,
          usd: c?.usd ?? 0
        };
      });

  return (
    <PixelPanel title="TEAM" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {items.length === 0 ? (
        <div style={{ padding: '8px 2px', color: 'var(--cth-ink-500)', fontSize: 'var(--cth-text-body-sm)' }}>
          {viewing ? 'This teammate has no agents.' : 'No agents yet.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', minHeight: 0, flex: 1 }}>
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
                  {/* Cost/token metadata — local cards only (this-machine ledger). */}
                  {a.usd !== null && (a.model || a.tokens > 0 || a.usd > 0) && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      fontFamily: 'var(--cth-font-mono, monospace)',
                      fontSize: 10, lineHeight: '14px',
                      color: 'var(--cth-ink-400, var(--cth-ink-500))',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                    }}>
                      {a.model && (
                        <span style={{ color: `var(--cth-${a.accent})`, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {a.model}
                        </span>
                      )}
                      {a.tokens > 0 && <span>{fmtTokens(a.tokens)} tok</span>}
                      <span style={{ marginLeft: 'auto', color: 'var(--cth-ink-700, var(--cth-ink-900))' }}>
                        {fmtUsd(a.usd)}
                      </span>
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
      {/* Session cost summary, pinned to the bottom of the team column. Hidden
          while viewing a teammate's read-only roster (cost is this-machine only). */}
      {!viewing && <CostFooter costs={costs} />}
    </PixelPanel>
  );
}

/** Bottom-pinned 'By model (session)' breakdown + grand TOTAL row, summed from
 *  the live per-agent session usage. Visually offset as a muted, divided panel. */
function CostFooter({ costs }: { costs: CostTotals }) {
  const models = Object.entries(costs.byModel)
    .sort((a, b) => b[1].usd - a[1].usd);
  const hasData = costs.total.tokens > 0 || costs.total.usd > 0 || models.length > 0;

  return (
    <div style={{
      marginTop: 8, paddingTop: 8,
      borderTop: '1px solid var(--cth-panel-border-color, var(--cth-ink-200))',
      flexShrink: 0
    }}>
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 9,
        letterSpacing: '0.05em', textTransform: 'uppercase',
        color: 'var(--cth-ink-500)', marginBottom: 6
      }}>
        By model (session)
      </div>
      {!hasData ? (
        <div style={{ fontSize: 'var(--cth-text-body-sm)', color: 'var(--cth-ink-400, var(--cth-ink-500))' }}>
          No cost recorded yet
        </div>
      ) : (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 3,
          fontFamily: 'var(--cth-font-mono, monospace)', fontSize: 10, lineHeight: '14px'
        }}>
          {models.map(([model, m]) => (
            <div key={model} style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{
                color: 'var(--cth-ink-700, var(--cth-ink-900))',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
              }}>
                {shortModel(model) || model}
              </span>
              <span style={{ marginLeft: 'auto', color: 'var(--cth-ink-500)' }}>
                {fmtTokens(m.tokens)} tok
              </span>
              <span style={{ minWidth: 52, textAlign: 'right', color: 'var(--cth-ink-700, var(--cth-ink-900))' }}>
                {fmtUsd(m.usd)}
              </span>
            </div>
          ))}
          <div style={{
            display: 'flex', alignItems: 'baseline', gap: 6,
            marginTop: 4, paddingTop: 4,
            borderTop: '1px dashed var(--cth-panel-border-color, var(--cth-ink-200))',
            fontFamily: 'var(--cth-font-display)'
          }}>
            <span style={{ color: 'var(--cth-ink-900)' }}>TOTAL</span>
            <span style={{ marginLeft: 'auto', color: 'var(--cth-ink-500)' }}>
              {fmtTokens(costs.total.tokens)} tok
            </span>
            <span style={{ minWidth: 52, textAlign: 'right', color: 'var(--cth-ink-900)' }}>
              {fmtUsd(costs.total.usd)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
