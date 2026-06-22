import { useEffect, useRef, useState } from 'react';
import { useStore, activeTeam, DEFAULT_TEAM_ID } from '@/store/store';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelButton } from '@/components/PixelButton';

/**
 * Per-team destructive actions, tucked behind a kebab so they never sit one
 * misclick away: "Clear work history" (any team) and "Delete team" (non-default
 * only). Both route through a confirm dialog before touching the main process —
 * clearing wipes the task board, shared board, pulse, and activity log but keeps
 * the roster, agent memory, and cost ledger; deleting removes the team entirely.
 */

type Pending = { kind: 'clear' } | { kind: 'delete' } | null;

export function TeamActionsMenu() {
  const team = useStore(activeTeam);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const isDefault = team.id === DEFAULT_TEAM_ID;

  // Close the popover on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const runClear = async () => {
    setBusy(true);
    try {
      const res = await window.cth.clearHistory(team.id);
      if (!res?.ok) window.alert(`Couldn't clear work history: ${res?.error ?? 'unknown error'}`);
    } catch (e) {
      window.alert(`Couldn't clear work history: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const runDelete = async () => {
    setBusy(true);
    try {
      // On success the main process emits a `teams:event` 'removed' which the
      // store handles (drops + switches away) — nothing more to do here.
      const res = await window.cth.teamsRemove(team.id);
      if (!res?.ok) window.alert(`Couldn't delete team: ${res?.error ?? 'unknown error'}`);
    } catch (e) {
      window.alert(`Couldn't delete team: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const menuItem = (label: string, onClick: () => void, danger = false): JSX.Element => (
    <button
      onClick={() => { setOpen(false); onClick(); }}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: '7px 12px', border: 'none', cursor: 'pointer',
        background: 'transparent',
        fontFamily: 'var(--cth-font-ui)', fontSize: 13,
        color: danger ? 'var(--cth-danger)' : 'var(--cth-ink-900)'
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--cth-cream-200)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {label}
    </button>
  );

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        className="cth-chip"
        data-active={open}
        title="Team actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: 28, height: 26, padding: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: open ? 'var(--cth-cream-200)' : 'var(--cth-cream-50)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
          color: 'var(--cth-ink-700)', cursor: 'pointer', border: 'none',
          fontSize: 16, lineHeight: 1, letterSpacing: 1
        }}
      >
        <span aria-hidden style={{ marginTop: -4 }}>⋯</span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 50,
            minWidth: 180, padding: '4px 0',
            background: 'var(--cth-cream-50)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-100), var(--cth-shadow-md)',
            borderRadius: 'var(--cth-radius-md)'
          }}
        >
          {menuItem('Clear work history…', () => setPending({ kind: 'clear' }))}
          {menuItem(
            isDefault ? 'Delete team (default)' : 'Delete team…',
            () => { if (!isDefault) setPending({ kind: 'delete' }); },
            !isDefault
          )}
          {isDefault && (
            <div style={{ padding: '2px 12px 6px', fontSize: 11, color: 'var(--cth-ink-300)' }}>
              The default team can't be deleted.
            </div>
          )}
        </div>
      )}

      {pending && (
        <div
          onClick={() => !busy && setPending(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 60,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.4)'
          }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ width: 440, maxWidth: '90vw' }}>
            <PixelPanel variant="dialog" title={pending.kind === 'clear' ? 'Clear work history' : 'Delete team'} noPadding>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 16 }}>
                {pending.kind === 'clear' ? (
                  <div style={{ fontSize: 13, color: 'var(--cth-ink-700)', lineHeight: 1.55 }}>
                    Clear <b>{team.name}</b>'s work history? This resets the task board, the shared
                    board, the team pulse, and the activity log.
                    <br /><br />
                    The roster, each agent's memory, and the cost totals are kept. This can't be undone.
                  </div>
                ) : (
                  <div style={{ fontSize: 13, color: 'var(--cth-ink-700)', lineHeight: 1.55 }}>
                    Delete the team <b>{team.name}</b>? This stops its agents, removes it from the
                    switcher, and erases its files on disk (including any copied API keys).
                    <br /><br />
                    This can't be undone.
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <PixelButton variant="ghost" size="sm" disabled={busy} onClick={() => setPending(null)}>Cancel</PixelButton>
                  <PixelButton
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                    onClick={() => { void (pending.kind === 'clear' ? runClear() : runDelete()); }}
                  >
                    {busy ? 'Working…' : pending.kind === 'clear' ? 'Clear history' : 'Delete team'}
                  </PixelButton>
                </div>
              </div>
            </PixelPanel>
          </div>
        </div>
      )}
    </div>
  );
}
