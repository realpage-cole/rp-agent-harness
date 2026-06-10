import { useEffect, useState } from 'react';

// Derive the trace-event shape from the preload-exposed API so the renderer
// never reaches across project boundaries for a type (window.cth is globally
// typed). Mirrors the IPC contract's TraceEvent.
export type TraceEvent = Awaited<ReturnType<Window['cth']['traceDetails']>>[number];

/**
 * Full tool-call traces for ONE agent — the payload-bearing companion to
 * `useAgentSpans` (which is payload-free). Fetches `window.cth.traceDetails`
 * on mount / agent-change, then refreshes on a ~5s interval so newly-run tools
 * surface without a manual reload. Returned newest-first (the IPC guarantees
 * the ordering); a teammate / un-instrumented agent simply yields [].
 */
const REFRESH_MS = 5000;

export function useTraceDetails(agentId: string, limit = 200): TraceEvent[] {
  const [traces, setTraces] = useState<TraceEvent[]>([]);

  useEffect(() => {
    let alive = true;
    setTraces([]);

    const load = (): void => {
      window.cth
        .traceDetails(agentId, limit)
        .then((rows) => {
          if (alive && Array.isArray(rows)) setTraces(rows);
        })
        .catch(() => {
          /* transcript not found / teammate — leave as [] */
        });
    };

    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [agentId, limit]);

  return traces;
}
