/**
 * MemoryManager — shared semantic memory for the hive, backed by LOCAL Ollama
 * embeddings + a Supabase pgvector index.
 *
 * Why not MemPalace: its embeddings are hardcoded to sentence-transformers/ONNX
 * models fetched from HuggingFace, which the RealPage network policy blocks. So
 * the harness embeds entirely LOCALLY via Ollama (`nomic-embed-text`) — nothing
 * leaves the machine to produce a vector — and stores the vectors in the same
 * Supabase project the team already syncs through. That makes recall a single
 * SHARED layer across teammates, sessions, and projects (one workspace-scoped
 * index), not a per-machine local rebuild.
 *
 * Division of labor:
 *   - WRITES: sync/memory.ts embeds each owned agent's memory.md (this manager's
 *     Ollama embedder, injected as a dep) and upserts the chunks into
 *     `memory_chunks` on the normal sync beat. Only sync/* ever touches Supabase.
 *   - READS: this manager embeds a query/locally and asks the SyncManager (via the
 *     injected MemoryVectorStore bridge) to run the cosine match RPC. The human
 *     Memory panel is the window into it.
 *
 * Because the store IS Supabase, semantic memory requires sync to be running +
 * signed in (the `storeReady` gate). With sync off the markdown memory still
 * works; there's just no shared semantic index. Degrades silently to no-op when
 * Ollama is unreachable. Runs in the Electron main process.
 */
import { embedOne, ping, type OllamaSettings, type EmbedKind } from './memory/ollama';
import type { MemoryChunkHit } from './sync';

export interface MemorySettings extends OllamaSettings {
  /** User master toggle (config.semanticMemory). */
  enabled: boolean;
}

/**
 * The read seam into the shared vector store — implemented by the SyncManager
 * (the only module that talks to Supabase), wired in index.ts. Keeps this manager
 * free of any Supabase import and unit-testable with a fake store.
 */
export interface MemoryVectorStore {
  /** Is the shared store reachable (sync running + signed in + workspace set)? */
  canRun(): boolean;
  /** Cosine top-K over the whole workspace's memory for a locally-embedded query. */
  match(embedding: number[], k: number, agent?: string): Promise<MemoryChunkHit[]>;
  /** Most recently updated chunks across the workspace (the wake-up digest). */
  recent(k: number): Promise<MemoryChunkHit[]>;
}

export interface MemoryStatus {
  /** Ollama reachable AND the embedding model pulled. */
  available: boolean;
  /** User setting (config.semanticMemory). */
  enabled: boolean;
  /** The shared Supabase store is up (sync running + signed in). */
  storeReady: boolean;
  /** available && enabled && storeReady — semantic memory is fully working. */
  active: boolean;
  /** Where we reach Ollama + which model — surfaced so the panel can guide setup. */
  host: string;
  model: string;
}

/** How long a reachability probe is trusted before re-pinging (status is polled). */
const PING_TTL_MS = 15_000;
/** Default recall breadth. */
const DEFAULT_RESULTS = 8;

export class MemoryManager {
  private pingCache: { at: number; ok: boolean } | null = null;

  constructor(
    private getSettings: () => MemorySettings,
    private store: MemoryVectorStore
  ) {}

  // — config gates —

  enabled(): boolean { return this.getSettings().enabled; }

  /** Sync best-effort "semantic memory is configured + the store is up" — used at
   *  agent spawn (must not await a network ping). Doesn't prove Ollama is up; the
   *  embed step degrades to no-op if it isn't. */
  configured(): boolean {
    return this.getSettings().enabled && this.store.canRun();
  }

  /** Cached Ollama reachability probe (TTL'd so status polling doesn't hammer it). */
  private async reachable(): Promise<boolean> {
    const now = Date.now();
    if (this.pingCache && now - this.pingCache.at < PING_TTL_MS) return this.pingCache.ok;
    const ok = await ping(this.getSettings());
    this.pingCache = { at: now, ok };
    return ok;
  }

  /** Drop the cached probe so the next status() re-checks immediately (e.g. after
   *  the user starts Ollama or pulls the model). */
  resetProbe(): void { this.pingCache = null; }

  async status(): Promise<MemoryStatus> {
    const s = this.getSettings();
    const available = await this.reachable();
    const storeReady = this.store.canRun();
    return {
      available,
      enabled: s.enabled,
      storeReady,
      active: available && s.enabled && storeReady,
      host: s.host,
      model: s.model
    };
  }

  // — lifecycle (kept as thin hooks so index.ts wiring is unchanged) —

  /** Warm the reachability probe so the first status() is instant. No loops: the
   *  embedding WRITES ride the sync beat (sync/memory.ts); there's no local mine. */
  start(): void { void this.reachable(); }
  stop(): void { /* nothing to tear down — no timers, no child processes */ }

  /** Extra env merged into spawns / the reflector's headless Claude. Empty now:
   *  agents have no embedding CLI (embedding is harness-side via Ollama). Retained
   *  so the reflector wiring (which merges this) stays put. */
  env(): Record<string, string> { return {}; }

  // — recall (read) —

  /** Semantic search across the shared workspace memory. Embeds the query LOCALLY
   *  (Ollama, query-kind prefix), then runs the cosine match RPC. Returns the
   *  formatted hits as text for the panel. */
  async search(
    query: string,
    opts: { wing?: string; results?: number } = {}
  ): Promise<{ ok: boolean; output: string; error?: string }> {
    const gate = this.gate();
    if (gate) return { ok: false, output: '', error: gate };
    const embedding = await this.embedQuery(query);
    if (!embedding) return { ok: false, output: '', error: "couldn't reach Ollama to embed the query" };
    const hits = await this.store.match(embedding, opts.results ?? DEFAULT_RESULTS, opts.wing);
    return { ok: true, output: formatHits(hits) };
  }

  /** Session-start digest: the most recently updated memory across the team. */
  async wakeUp(_wing?: string): Promise<{ ok: boolean; output: string; error?: string }> {
    const gate = this.gate();
    if (gate) return { ok: false, output: '', error: gate };
    const hits = await this.store.recent(DEFAULT_RESULTS);
    return { ok: true, output: formatHits(hits) };
  }

  /** Embed a query string for recall (or null if Ollama is unreachable). */
  private async embedQuery(text: string, kind: EmbedKind = 'query'): Promise<number[] | null> {
    return embedOne(text, this.getSettings(), kind);
  }

  /** Why recall can't run right now (or null when it can). */
  private gate(): string | null {
    const s = this.getSettings();
    if (!s.enabled) return 'semantic memory is turned off';
    if (!this.store.canRun()) return 'shared memory needs team sync turned on and signed in';
    return null;
  }
}

/** Render recall hits as a readable text block for the Memory panel. Each hit is
 *  the owning agent (+ owner + match score) above its memory snippet. */
function formatHits(hits: MemoryChunkHit[]): string {
  if (hits.length === 0) return '';
  return hits
    .map((h) => {
      const who = h.name || h.agentId || 'agent';
      const owner = h.ownerLabel ? ` · ${h.ownerLabel}` : '';
      const score = h.similarity != null ? ` (${Math.round(h.similarity * 100)}%)` : '';
      return `▸ ${who}${owner}${score}\n${h.content.trim()}`;
    })
    .join('\n\n');
}
