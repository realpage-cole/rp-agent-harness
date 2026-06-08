import { PixelPanel } from '@/components/PixelPanel';

export interface BootSplashProps {
  /** Headline above the loader (e.g. the panel title). */
  title?: string;
  /** Body copy under the spinner. */
  message?: string;
}

/**
 * Neutral "Starting…" loader shown while the orchestrator agent is coming up on
 * launch. No persona framing.
 */
export function BootSplash({
  title = 'STARTING',
  message = 'Bringing the orchestrator online and getting the team ready. Hang tight…'
}: BootSplashProps) {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'none'
    }}>
      <div style={{ pointerEvents: 'auto', width: 360 }}>
        <PixelPanel variant="dialog" title={title} noPadding>
          <div style={{
            padding: 20,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14
          }}>
            <div style={{ display: 'flex', gap: 6 }}>
              {[0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  style={{
                    width: 12, height: 12,
                    borderRadius: '50%',
                    background: 'var(--cth-sky)',
                    animation: 'cth-blink 1s ease-in-out infinite',
                    animationDelay: `${i * 0.15}s`
                  }}
                />
              ))}
            </div>
            <p style={{
              margin: 0, fontSize: 14, lineHeight: '20px', textAlign: 'center',
              color: 'var(--cth-ink-700)'
            }}>
              {message}
            </p>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}
