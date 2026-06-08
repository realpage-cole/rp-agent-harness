import { useStore } from '@/store/store';
import { PixelButton } from '@/components/PixelButton';
import { useHumanQueue } from '@/hooks/useHumanQueue';

/**
 * "Needs you" banner: shows when the orchestrator has parked one or more
 * questions for the human (the old office "ASK ME" board). Clicking through
 * opens the Command Center's human tab. Renders nothing when the queue is empty.
 */
export function NeedsYouBanner() {
  const { count } = useHumanQueue();
  const requestCommandCenterTab = useStore((s) => s.requestCommandCenterTab);

  if (count === 0) return null;

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        padding: '10px 14px',
        background: 'var(--cth-coral-light)',
        boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
        borderRadius: 6
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          width: 10, height: 10, borderRadius: '50%',
          background: 'var(--cth-status-blocked)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)'
        }} />
        <span style={{ fontSize: 'var(--cth-text-body-md)', color: 'var(--cth-ink-900)' }}>
          <strong>{count}</strong> {count === 1 ? 'question needs' : 'questions need'} your answer
        </span>
      </div>
      <PixelButton size="sm" onClick={() => requestCommandCenterTab('human')}>
        Answer →
      </PixelButton>
    </div>
  );
}
