import { useState } from 'react';
import { useFleetTelemetry, totalTokens, cacheFraction } from '@/hooks/useTelemetry';
import { useTraceDetails, type TraceEvent } from '@/hooks/useTraceDetails';

/**
 * Per-agent "translucent" tool trace (#7B.2) — shows the FULL input + output
 * behind every tool call, not just a duration bar. The header band keeps the
 * cumulative cost with the cache-vs-fresh split visible (the headline cost win),
 * and the body is an expandable list of real tool calls mined from the agent's
 * transcript (via `useTraceDetails`). Collapsed rows are cheap (tool · title ·
 * ✓/✗ · duration); expanding a row lazily paints its INPUT and OUTPUT payloads
 * so the list stays fast. Newest-first. Empty / teammate agents render the
 * empty state gracefully.
 */
export function ToolWaterfall({ agentId }: { agentId: string }) {
  const traces = useTraceDetails(agentId);
  const { samples } = useFleetTelemetry();
  const sample = samples[agentId];

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--cth-paper-200)', overflow: 'hidden' }}>
      {/* Header band: cumulative cost + cache-vs-fresh split (from live telemetry) */}
      <div style={{
        flexShrink: 0, padding: '8px 10px', background: 'var(--cth-cream-200)',
        boxShadow: 'inset 0 -2px 0 var(--cth-ink-900)',
        fontFamily: 'var(--cth-font-mono)', fontSize: 12, color: 'var(--cth-ink-900)',
        display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'baseline'
      }}>
        {sample ? (
          <>
            <span><strong>${sample.usd.toFixed(2)}</strong></span>
            <span style={{ color: 'var(--cth-ink-700)' }}>
              fresh {fmtTokens(sample.input + sample.cacheCreation)}t
            </span>
            <span style={{ color: 'var(--cth-sky)' }}>
              cache {fmtTokens(sample.cacheRead)}t ({Math.round(cacheFraction(sample) * 100)}%)
            </span>
            {sample.model && <span style={{ color: 'var(--cth-ink-500)' }}>{sample.model}</span>}
            <span style={{ color: 'var(--cth-ink-500)' }}>{fmtTokens(totalTokens(sample))}t total</span>
          </>
        ) : (
          <span style={{ color: 'var(--cth-ink-500)' }}>no live telemetry yet — spawn / respawn this agent to instrument it</span>
        )}
      </div>

      {/* Expandable trace list (newest-first) */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10 }}>
        {traces.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
            No tool calls yet. Each tool the agent runs appears here — expand a row to see its full input and output.
          </div>
        ) : (
          traces.map((t) => <TraceRow key={t.id} trace={t} />)
        )}
      </div>
    </div>
  );
}

function TraceRow({ trace }: { trace: TraceEvent }) {
  const [open, setOpen] = useState(false);
  const ok = trace.success;
  const accent = ok ? 'var(--cth-mint)' : 'var(--cth-coral)';

  return (
    <div style={{ marginBottom: 4, boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', background: 'var(--cth-paper-100)' }}>
      {/* Collapsed row — the clickable summary */}
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          all: 'unset', boxSizing: 'border-box', cursor: 'pointer', width: '100%',
          display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px',
          borderLeft: `3px solid ${accent}`
        }}
        title={open ? 'Collapse' : 'Expand'}
      >
        <span style={{ width: 12, textAlign: 'center', fontSize: 10, color: 'var(--cth-ink-500)' }}>
          {open ? '▾' : '▸'}
        </span>
        <span style={{ width: 90, flexShrink: 0, fontFamily: 'var(--cth-font-mono)', fontSize: 11, fontWeight: 600, color: 'var(--cth-ink-900)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {trace.tool}
        </span>
        <span style={{ flex: 1, minWidth: 0, fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-700)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={trace.title}>
          {trace.title}
        </span>
        {typeof trace.durationMs === 'number' && (
          <span style={{ flexShrink: 0, fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)' }}>
            {fmtDur(trace.durationMs)}
          </span>
        )}
        <span style={{ flexShrink: 0, width: 12, textAlign: 'center', fontSize: 11, color: accent }}>
          {ok ? '✓' : '✗'}
        </span>
      </button>

      {/* Expanded payload — lazily painted only when open */}
      {open && (
        <div style={{ padding: '4px 8px 8px', borderTop: '1px solid var(--cth-ink-300)' }}>
          <PayloadBlock label="INPUT" body={trace.input} />
          <PayloadBlock label="OUTPUT" body={trace.output} accent={ok ? undefined : 'var(--cth-coral)'} />
          {trace.truncated && (
            <div style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-500)', marginTop: 4 }}>
              … (truncated — payload capped at 50,000 chars)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PayloadBlock({ label, body, accent }: { label: string; body: string; accent?: string }) {
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: accent ?? 'var(--cth-ink-500)', marginBottom: 2 }}>
        {label}
      </div>
      <pre style={{
        margin: 0, maxHeight: 280, overflow: 'auto',
        background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
        padding: '6px 8px', fontFamily: 'var(--cth-font-mono)', fontSize: 11,
        color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
      }}>
        {body || '(empty)'}
      </pre>
    </div>
  );
}

function fmtDur(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}
