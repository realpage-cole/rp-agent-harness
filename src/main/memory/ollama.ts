/**
 * Ollama embedding client — the LOCAL embedding substrate for shared semantic
 * memory. RealPage's network policy blocks HuggingFace model downloads, so we do
 * NOT use MemPalace's sentence-transformers/ONNX path; instead every machine runs
 * Ollama locally (already an approved, fully-local dependency) and embeds via
 * `nomic-embed-text`. Nothing leaves the machine: text in → 768-dim vector out,
 * over localhost. The vectors are then shared via Supabase pgvector (see
 * sync/memory.ts), which is what makes recall a team-wide, cross-session layer.
 *
 * Deliberately free of any `electron` import (plain Node + global fetch) so it can
 * be unit-/smoke-tested in isolation, matching the sync/* modules.
 */

/** How the harness reaches the local Ollama server. Read fresh from config so a
 *  Settings change applies without a restart. */
export interface OllamaSettings {
  /** Base URL, e.g. http://localhost:11434. */
  host: string;
  /** Embedding model tag, e.g. nomic-embed-text. */
  model: string;
}

/** nomic-embed-text is asymmetric: stored passages and search queries must carry
 *  different task prefixes or recall quality drops noticeably. We embed memory
 *  CHUNKS as documents and the SEARCH BOX text as a query. */
export type EmbedKind = 'document' | 'query';
const PREFIX: Record<EmbedKind, string> = {
  document: 'search_document: ',
  query: 'search_query: '
};

/** The fixed embedding width we provision the pgvector column for. nomic-embed-text
 *  is 768-dim; a model whose output width differs would break the upsert, so we
 *  expose it for a guard at the call site. */
export const EMBED_DIM = 768;

const DEFAULT_TIMEOUT_MS = 30_000;

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, done: () => clearTimeout(t) };
}

function baseUrl(s: OllamaSettings): string {
  return (s.host || 'http://localhost:11434').replace(/\/+$/, '');
}

/**
 * Embed a batch of texts via Ollama's `/api/embed`. Returns one vector per input
 * (same order), or `null` on ANY failure (server down, model missing, bad shape) —
 * the caller treats null as "embedding unavailable this pass" and simply retries
 * later, never throwing into a sync/mine loop. Empty input → []. Each text is
 * task-prefixed for the given `kind`.
 */
export async function embed(
  texts: string[],
  settings: OllamaSettings,
  kind: EmbedKind = 'document',
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  const input = texts.map((t) => PREFIX[kind] + t);
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetch(`${baseUrl(settings)}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: settings.model, input }),
      signal
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { embeddings?: unknown };
    const out = json.embeddings;
    if (!Array.isArray(out) || out.length !== texts.length) return null;
    // Validate each row is a numeric vector of the expected width.
    const vectors: number[][] = [];
    for (const row of out) {
      if (!Array.isArray(row) || row.length !== EMBED_DIM) return null;
      vectors.push(row as number[]);
    }
    return vectors;
  } catch {
    return null; // network/abort/parse — unavailable this pass
  } finally {
    done();
  }
}

/** Embed a single text; convenience over embed([t]). null on failure. */
export async function embedOne(
  text: string,
  settings: OllamaSettings,
  kind: EmbedKind = 'document',
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<number[] | null> {
  const out = await embed([text], settings, kind, timeoutMs);
  return out && out[0] ? out[0] : null;
}

/**
 * Is the Ollama server reachable AND does it have the configured embedding model
 * pulled? Both matter: a running server without the model can't embed. Cheap GET
 * to `/api/tags`; best-effort, short timeout, never throws.
 */
export async function ping(settings: OllamaSettings, timeoutMs = 4000): Promise<boolean> {
  const { signal, done } = withTimeout(timeoutMs);
  try {
    const res = await fetch(`${baseUrl(settings)}/api/tags`, { signal });
    if (!res.ok) return false;
    const json = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    const models = json.models ?? [];
    // Match with or without a tag suffix, e.g. "nomic-embed-text" ≈ "nomic-embed-text:latest".
    const want = settings.model.split(':')[0];
    return models.some((m) => {
      const n = (m.name ?? m.model ?? '').split(':')[0];
      return n === want;
    });
  } catch {
    return false;
  } finally {
    done();
  }
}

/** Render a vector as the pgvector text literal `[v1,v2,...]` — the form the
 *  match_memory_chunks RPC casts to `vector`, and the most reliable way to pass a
 *  vector through supabase-js (which has no native vector type). */
export function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
