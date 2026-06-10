import { useEffect, useState } from 'react';

// Derive the cost-totals shape from the preload-exposed API so the renderer
// never reaches across project boundaries for a type (window.cth is globally
// typed). Mirrors the IPC contract's CostTotals.
export type CostTotals = Awaited<ReturnType<Window['cth']['costTotals']>>;

/** Empty-but-valid totals so consumers never need a null guard before mount. */
const EMPTY: CostTotals = { byAgent: {}, byModel: {}, total: { tokens: 0, usd: 0 } };

/**
 * SESSION cost/token totals — each agent's current-session usage from the live
 * OTel collector (not the all-time ledger). Fetches `window.cth.costTotals` on
 * mount, then refreshes on a short interval so live spend surfaces on the roster
 * as it accrues. Always returns a valid (possibly all-zero) CostTotals.
 */
const REFRESH_MS = 8000;

export function useCostTotals(): CostTotals {
  const [totals, setTotals] = useState<CostTotals>(EMPTY);

  useEffect(() => {
    let alive = true;

    const load = (): void => {
      window.cth
        .costTotals()
        .then((t) => {
          if (alive && t) setTotals(t);
        })
        .catch(() => {
          /* ledger missing / unreadable — keep prior (or empty) totals */
        });
    };

    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return totals;
}
