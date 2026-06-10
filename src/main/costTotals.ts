/**
 * Cost totals — SESSION-based aggregation of live per-agent usage.
 *
 * Rolls the live telemetry usage samples (one cumulative AgentUsageSample per
 * agent for its CURRENT session, from the OTel collector — telemetry.ts) into
 * per-agent and per-model token+USD sums plus a grand total. This is the same
 * source the trace header uses, so the team column agrees with it.
 *
 * Deliberately NOT all-time: it reflects what each agent has spent this session,
 * not the durable cost-ledger lifetime. Pure + best-effort — never throws.
 */
import type { AgentUsageSample } from './telemetry';

export interface CostAgentTotal {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** input + output + cacheRead + cacheCreation. */
  tokens: number;
  usd: number;
  /** The model on this agent's session sample, or null. */
  model: string | null;
}

export interface CostTotals {
  byAgent: Record<string, CostAgentTotal>;
  byModel: Record<string, { tokens: number; usd: number }>;
  total: { tokens: number; usd: number };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Aggregate session cost totals from the live usage samples. Each sample is one
 * agent's cumulative current-session usage; we sum per agent (defensive — the
 * collector already yields one per agent), per model, and overall. Samples with
 * no agentId are skipped. Returns all-zero totals for an empty list.
 */
export function costTotalsFromUsage(samples: AgentUsageSample[]): CostTotals {
  const totals: CostTotals = { byAgent: {}, byModel: {}, total: { tokens: 0, usd: 0 } };
  if (!Array.isArray(samples)) return totals;

  for (const s of samples) {
    const agentId = s && typeof s.agentId === 'string' ? s.agentId : null;
    if (!agentId) continue;

    const input = num(s.input);
    const output = num(s.output);
    const cacheRead = num(s.cacheRead);
    const cacheCreation = num(s.cacheCreation);
    const tokens = input + output + cacheRead + cacheCreation;
    const usd = num(s.usd);
    const model = typeof s.model === 'string' && s.model ? s.model : null;

    const a = totals.byAgent[agentId] ?? (totals.byAgent[agentId] = {
      input: 0, output: 0, cacheRead: 0, cacheCreation: 0, tokens: 0, usd: 0, model: null
    });
    a.input += input;
    a.output += output;
    a.cacheRead += cacheRead;
    a.cacheCreation += cacheCreation;
    a.tokens += tokens;
    a.usd += usd;
    if (model) a.model = model;

    if (model) {
      const m = totals.byModel[model] ?? (totals.byModel[model] = { tokens: 0, usd: 0 });
      m.tokens += tokens;
      m.usd += usd;
    }

    totals.total.tokens += tokens;
    totals.total.usd += usd;
  }

  return totals;
}
