import { useState } from 'react';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelButton } from '@/components/PixelButton';
import { useStore } from '@/store/store';
import { cloneTeam } from '@/ipc/teams';

export interface CloneTeamModalProps {
  /** The team to clone FROM (configs-only, fresh start). */
  sourceTeamId: string;
  /** Display name of the source, used to seed the new name field. */
  sourceName: string;
  onClose: () => void;
}

/**
 * CloneTeamModal (FE-5) — name a new team and clone the active team's CONFIGS
 * into it (roster/models/secrets copied; memory/board/tasks/inbox reset — see
 * architect §5). On success the new team is added optimistically and switched to;
 * its god is bootstrapped by useHive (which re-runs when teamList grows). The
 * backend also emits a `teams:event` 'created' that reconciles the entry.
 */
export function CloneTeamModal({ sourceTeamId, sourceName, onClose }: CloneTeamModalProps) {
  const [name, setName] = useState(`${sourceName} copy`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) { setError('Name is required'); return; }
    setBusy(true);
    setError(null);
    const res = await cloneTeam(sourceTeamId, trimmed);
    if (!res.ok || !res.teamId) {
      setBusy(false);
      setError(res.error ?? 'Clone failed');
      return;
    }
    // Optimistically register + switch; the teams:event 'created' refines it.
    const store = useStore.getState();
    store.upsertTeam({ id: res.teamId, name: trimmed });
    store.setActiveTeam(res.teamId);
    onClose();
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 420, maxWidth: '90vw' }}>
        <PixelPanel variant="dialog" title="Clone team" noPadding>
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <p style={{ margin: 0, fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-700)' }}>
              Clone <strong>{sourceName}</strong>'s setup into a fresh team — same roster, models
              and keys, but a clean memory, board, tasks and inbox. Both teams run in parallel.
            </p>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: 'var(--cth-ink-500)' }}>
              New team name
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void submit(); }}
                disabled={busy}
                style={{
                  fontSize: 14, color: 'var(--cth-ink-900)',
                  background: 'var(--cth-cream-100)', border: '1px solid var(--cth-ink-100)',
                  borderRadius: 4, padding: '6px 8px'
                }}
              />
            </label>
            {error && (
              <p style={{ margin: 0, fontSize: 13, color: 'var(--cth-status-blocked)' }}>{error}</p>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <PixelButton variant="secondary" size="md" onClick={onClose} disabled={busy}>Cancel</PixelButton>
              <PixelButton variant="primary" size="md" onClick={() => void submit()} disabled={busy}>
                {busy ? 'Cloning…' : 'Clone team'}
              </PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}
