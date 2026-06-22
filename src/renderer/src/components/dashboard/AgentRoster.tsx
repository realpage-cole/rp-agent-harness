import { useEffect, useState } from 'react';
import { useStore, type Agent } from '@/store/store';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelBadge, type StatusKind } from '@/components/PixelBadge';
import { PixelButton } from '@/components/PixelButton';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { useTeammateAgents } from '@/hooks/useHiveView';
import { useCostTotals, type CostTotals } from '@/hooks/useCostTotals';
import { buildSpawnCommand, inferAgentProvider, tokenizeCommand, type HarnessConfig } from '@/store/config';
import { spawnPtyForTeam, hiveTasksFor } from '@/ipc/teams';
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
  const restorableAgents = useStore((s) => s.restorableAgents);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const activeTeamId = useStore((s) => s.activeTeamId);
  const setAddAgentOpen = useStore((s) => s.setAddAgentOpen);
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const bumpSharedAgents = useStore((s) => s.bumpSharedAgents);
  const teammate = useTeammateAgents(viewedOwner ? viewedOwner.machineId : null);
  const costs = useCostTotals();

  const viewing = viewedOwner !== null;

  // Config is needed to rebuild a spawn command when restoring agents that
  // predate the persisted `command` field. Fetched once; refreshed cheaply.
  const [config, setConfig] = useState<HarnessConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.cth.getConfig().then((c) => { if (!cancelled) setConfig(c); });
    return () => { cancelled = true; };
  }, []);

  // Each worker's actively-DOING ledger tasks (hive/tasks.json) — surfaced as a
  // small "doing N" chip on its row (click → the first task's detail). Scoped to
  // the team in view so it tracks team switches.
  const [doingByAgent, setDoingByAgent] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (viewing) { setDoingByAgent({}); return; }
    let cancelled = false;
    const poll = async () => {
      try {
        const raw = await hiveTasksFor(activeTeamId) as { tasks?: Array<{ id?: string; status?: string; assignee?: string }> } | null;
        if (cancelled) return;
        const map: Record<string, string[]> = {};
        for (const t of (raw && Array.isArray(raw.tasks)) ? raw.tasks : []) {
          if (t?.status === 'doing' && typeof t.assignee === 'string' && t.assignee && typeof t.id === 'string') {
            (map[t.assignee] = map[t.assignee] ?? []).push(t.id);
          }
        }
        setDoingByAgent(map);
      } catch { /* keep last good */ }
    };
    void poll();
    const iv = setInterval(() => { void poll(); }, 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [viewing, activeTeamId]);

  // Per-agent publish feedback ('busy' → 'ok'), and the in-app publish dialog
  // (Electron renderers can't use window.prompt, so we collect "why" here).
  const [pubState, setPubState] = useState<Record<string, 'busy' | 'ok'>>({});
  const [publishTarget, setPublishTarget] = useState<Agent | null>(null);
  const [publishWhy, setPublishWhy] = useState('');
  const [restoring, setRestoring] = useState(false);

  const openPublish = (agent: Agent): void => { setPublishWhy(''); setPublishTarget(agent); };

  const confirmPublish = async () => {
    const agent = publishTarget;
    if (!agent) return;
    const why = publishWhy.trim();
    setPublishTarget(null);
    let customPrompt = '';
    try {
      const info = await window.cth.getAgentPrompt(agent.id);
      customPrompt = info?.custom ?? '';
    } catch { /* best-effort — publish without the addendum */ }
    const meta = (await window.cth.hiveRegistry().catch(() => null))?.agents?.[agent.id];
    setPubState((s) => ({ ...s, [agent.id]: 'busy' }));
    let res: { ok: boolean; error?: string };
    try {
      res = await window.cth.publishAgent({
        name: agent.name,
        role: agent.description || undefined,
        model: agent.model,
        accent: agent.accent,
        capabilities: meta?.capabilities,
        customPrompt: customPrompt || undefined
      }, why);
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (res.ok) {
      setPubState((s) => ({ ...s, [agent.id]: 'ok' }));
      bumpSharedAgents();
      setTimeout(() => setPubState((s) => { const n = { ...s }; delete n[agent.id]; return n; }), 1800);
    } else {
      setPubState((s) => { const n = { ...s }; delete n[agent.id]; return n; });
      const err = res.error ?? 'unknown error';
      const msg = /sign in|workspace/i.test(err)
        ? 'Turn on team sync and sign in (Settings → Sync), and set a workspace, to publish to the shared library.'
        : `Publish failed: ${err}`;
      window.alert(msg);
    }
  };

  /** Respawn every worker from the previous session with its ORIGINAL agent id,
   *  cwd, model and command — the hive workspace reattaches by itself. */
  const restoreTeam = async () => {
    if (restoring) return;
    setRestoring(true);
    const prevSel = useStore.getState().selectedId;
    try {
      for (const a of [...restorableAgents]) {
        const provider = inferAgentProvider(a.command, a.provider);
        const command = (a.command ?? '').trim() || (config ? buildSpawnCommand(config, a.model, provider) : '');
        if (!command || !a.cwd) { useStore.getState().removeRestorableAgent(a.id); continue; }
        const [exe, ...args] = tokenizeCommand(command);
        const ptyId = a.ptyId ?? `pty-${a.id}`;
        const res = await spawnPtyForTeam({
          id: ptyId, cwd: a.cwd, command: exe, provider, args, cols: 100, rows: 30,
          resume: true, isolate: !!a.worktreePath,
          hive: { id: a.id, name: a.name, provider, cwd: a.cwd, role: a.description }
        }, useStore.getState().activeTeamId);
        if (res.ok) {
          useStore.getState().addAgent({
            ...a, provider, ptyId, archived: false, status: 'idle',
            action: 'starting up', carrying: undefined, currentStation: 'desk',
            recentTextTs: Date.now()
          });
        } else {
          console.error('[restore] spawn failed for', a.id, res.error);
        }
      }
    } finally {
      const sel = useStore.getState();
      if (prevSel && sel.agents.some((x) => x.id === prevSel)) sel.select(prevSel);
      setRestoring(false);
    }
  };
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
    <>
    <PixelPanel title="TEAM" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {items.length === 0 ? (
        <div style={{ padding: '8px 2px', color: 'var(--cth-ink-500)', fontSize: 'var(--cth-text-body-sm)' }}>
          {viewing ? 'This teammate has no agents.' : 'No agents yet.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', minHeight: 0, flex: 1 }}>
          {items.map((a) => {
            const selected = a.selectable && a.id === selectedId;
            const raw = a.selectable ? localAgents.find((x) => x.id === a.id) : undefined;
            const doing = doingByAgent[a.id] ?? [];
            const ps = pubState[a.id];
            return (
              <button
                key={a.id}
                className="cth-roster-row"
                onClick={a.selectable ? () => select(a.id) : undefined}
                style={{
                  position: 'relative',
                  display: 'flex', alignItems: 'center', gap: 10,
                  width: '100%', textAlign: 'left', cursor: a.selectable ? 'pointer' : 'default',
                  padding: 8, border: 'none', borderRadius: 'var(--cth-radius-md)',
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
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      {/* Actively-doing ledger tasks → open the first one's detail. */}
                      {doing.length > 0 && (
                        <span
                          role="button"
                          title={`actively working ${doing.length} task${doing.length === 1 ? '' : 's'} — click to open`}
                          onClick={(e) => { e.stopPropagation(); openTaskDetail(doing[0]); }}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 3,
                            padding: '1px 6px', borderRadius: 'var(--cth-radius-pill)',
                            background: 'var(--cth-sky-light)', color: 'var(--cth-ink-900)',
                            fontFamily: 'var(--cth-font-ui)', fontSize: 10, lineHeight: '14px',
                            cursor: 'pointer'
                          }}
                        >
                          <span aria-hidden style={{ fontSize: 9 }}>✎</span> {doing.length}
                        </span>
                      )}
                      <PixelBadge status={a.status} />
                    </span>
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
                {/* Publish to the shared library — hover-revealed (see .cth-roster-row),
                    local agents only. 'ok' pins green briefly on success. */}
                {raw && (
                  <span
                    role="button"
                    className={ps === 'ok' ? undefined : 'cth-row-action'}
                    title="Publish this agent to the shared library"
                    onClick={(e) => { e.stopPropagation(); if (ps !== 'busy') openPublish(raw); }}
                    style={{
                      position: 'absolute', right: 8, bottom: 8,
                      fontFamily: 'var(--cth-font-ui)', fontSize: 10, lineHeight: '14px',
                      padding: '2px 8px', borderRadius: 'var(--cth-radius-pill)',
                      whiteSpace: 'nowrap', cursor: ps === 'busy' ? 'default' : 'pointer',
                      color: ps === 'ok' ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)',
                      background: ps === 'ok' ? 'var(--cth-mint)' : 'var(--cth-cream-50)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
                    }}
                  >
                    {ps === 'ok' ? 'Published ✓' : ps === 'busy' ? 'Publishing…' : 'Publish ↑'}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {/* Team actions — relocated from the old bottom strip. Local view only;
          a teammate's roster is read-only. */}
      {!viewing && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexShrink: 0 }}>
          <PixelButton variant="secondary" size="sm" onClick={() => setAddAgentOpen(true)}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <Icon name="plus" style={{ width: 13, height: 13 }} /> Add agent
            </span>
          </PixelButton>
          {restorableAgents.length > 0 && (
            <PixelButton
              variant="primary"
              size="sm"
              onClick={restoreTeam}
              disabled={restoring}
              style={{ flex: 1 }}
            >
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="play" style={{ width: 13, height: 13 }} />
                {restoring ? 'Restoring…' : `Restore team (${restorableAgents.length})`}
              </span>
            </PixelButton>
          )}
        </div>
      )}
      {/* Session cost summary, pinned to the bottom of the team column. Hidden
          while viewing a teammate's read-only roster (cost is this-machine only). */}
      {!viewing && <CostFooter costs={costs} />}
    </PixelPanel>

    {publishTarget && (
      <div
        onClick={() => setPublishTarget(null)}
        style={{
          position: 'fixed', inset: 0, zIndex: 60,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.4)'
        }}
      >
        <div onClick={(e) => e.stopPropagation()} style={{ width: 420, maxWidth: '90vw' }}>
          <PixelPanel variant="dialog" title="Publish agent" noPadding>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 14 }}>
              <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: 1.5 }}>
                Publish <b>{publishTarget.name}</b> to the shared agent library so teammates can add it to their hive.
              </div>
              <label style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
                What makes this agent worth sharing? (optional)
              </label>
              <textarea
                value={publishWhy}
                onChange={(e) => setPublishWhy(e.target.value)}
                autoFocus
                rows={3}
                placeholder="e.g. tuned for RealPage TFS + Salesforce SR workflows"
                style={{
                  resize: 'vertical', padding: '6px 8px',
                  background: 'var(--cth-paper-100)', border: 'none',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                  borderRadius: 'var(--cth-radius-md)',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 13,
                  color: 'var(--cth-ink-900)', outline: 'none'
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <PixelButton variant="ghost" size="sm" onClick={() => setPublishTarget(null)}>Cancel</PixelButton>
                <PixelButton variant="primary" size="sm" onClick={() => { void confirmPublish(); }}>Publish ↑</PixelButton>
              </div>
            </div>
          </PixelPanel>
        </div>
      </div>
    )}
    </>
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
