/**
 * Memory chunking — split an agent's `memory.md` into bounded, self-contained
 * pieces for embedding. Smaller chunks make cosine recall sharper (a query hits
 * the one relevant note, not a whole 100 KB file), and keeping each chunk under
 * the embedder's context window avoids silent truncation.
 *
 * Strategy: split on Markdown headings into sections, keep the nearest heading as
 * context on every chunk derived from it, and further split any over-long section
 * along paragraph (blank-line) boundaries. Pure + electron-free for testability.
 */

/** Soft upper bound on chunk size (characters). ~375 tokens at 4 chars/token —
 *  comfortably inside nomic-embed-text's window, small enough for sharp recall. */
const MAX_CHARS = 1500;

/** Drop chunks shorter than this (just a bare heading, a stray bullet) — they add
 *  index noise without recall value. */
const MIN_CHARS = 16;

function isHeading(line: string): boolean {
  return /^#{1,6}\s/.test(line);
}

/** Group lines into [heading, ...body] sections. Leading content before the first
 *  heading becomes its own headingless section. */
function sections(body: string): Array<{ heading: string; text: string }> {
  const lines = body.split('\n');
  const out: Array<{ heading: string; text: string }> = [];
  let heading = '';
  let buf: string[] = [];
  const flush = (): void => {
    const text = buf.join('\n').trim();
    if (text || heading) out.push({ heading, text });
    buf = [];
  };
  for (const line of lines) {
    if (isHeading(line)) {
      flush();
      heading = line.trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/** Split one section's text into <=MAX_CHARS pieces along blank-line paragraph
 *  boundaries; a single paragraph longer than MAX is hard-split as a last resort. */
function splitBody(text: string): string[] {
  if (text.length <= MAX_CHARS) return text ? [text] : [];
  const paras = text.split(/\n\s*\n/);
  const pieces: string[] = [];
  let cur = '';
  const push = (): void => { if (cur.trim()) pieces.push(cur.trim()); cur = ''; };
  for (const para of paras) {
    if (para.length > MAX_CHARS) {
      push();
      for (let i = 0; i < para.length; i += MAX_CHARS) pieces.push(para.slice(i, i + MAX_CHARS));
      continue;
    }
    if ((cur + '\n\n' + para).length > MAX_CHARS) push();
    cur = cur ? cur + '\n\n' + para : para;
  }
  push();
  return pieces;
}

/**
 * Chunk a memory.md body into embed-ready text pieces. Each chunk carries its
 * section heading (when any) so an embedded fragment keeps its context. Returns
 * [] for empty/whitespace input. The caller assigns each chunk a stable ordinal
 * id (its index) — re-chunking the same content is deterministic.
 */
export function chunkMemory(body: string): string[] {
  const chunks: string[] = [];
  for (const { heading, text } of sections(body)) {
    for (const piece of splitBody(text)) {
      const withHeading = heading ? `${heading}\n${piece}` : piece;
      if (withHeading.trim().length >= MIN_CHARS) chunks.push(withHeading);
    }
    // A heading with no body still carries meaning (a topic marker) — keep it if
    // it's the only thing in its section and long enough to matter.
    if (heading && !text.trim() && heading.length >= MIN_CHARS) chunks.push(heading);
  }
  return chunks;
}
