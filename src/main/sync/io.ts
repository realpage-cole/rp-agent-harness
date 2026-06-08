/**
 * Pure IO helpers for the SyncManager module — moved verbatim from the original
 * single-file `sync.ts`. No `electron` import, no client, no state: just file
 * tailing + the deterministic dedup uid + an error stringifier, so they're
 * trivially testable and shared by push.ts (and later memory.ts).
 */
import { openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MAX_TAIL_BYTES } from './types';

/**
 * Read complete newline-terminated lines from `path` starting at byte `offset`,
 * up to MAX_TAIL_BYTES. Returns the parsed lines and the byte offset just past
 * the last COMPLETE line (a partial trailing line — a write caught mid-append —
 * is left for the next pass). Cutting on a `\n` is a safe UTF-8 boundary since
 * `\n` is single-byte and never part of a multi-byte sequence. Returns null on
 * any IO error.
 */
export function readNewLines(
  path: string,
  offset: number,
  size: number
): { lines: string[]; nextOffset: number } | null {
  const toRead = Math.min(size - offset, MAX_TAIL_BYTES);
  if (toRead <= 0) return { lines: [], nextOffset: offset };
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const buf = Buffer.allocUnsafe(toRead);
    const bytes = readSync(fd, buf, 0, toRead, offset);
    if (bytes <= 0) return { lines: [], nextOffset: offset };
    const lastNL = buf.lastIndexOf(0x0a, bytes - 1); // last '\n' within what we read
    if (lastNL < 0) return { lines: [], nextOffset: offset }; // no complete line yet
    const complete = buf.subarray(0, lastNL + 1);
    const lines = complete.toString('utf8').split('\n').filter((l) => l.length > 0);
    return { lines, nextOffset: offset + complete.length };
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch { /* noop */ }
  }
}

/** Deterministic per-row dedup id: machine-scoped hash of the raw line. Each line
 *  embeds a ms `ts`, so distinct events never collide and re-pushing an identical
 *  line yields the same uid (→ ignoreDuplicates). */
export function uid(machineId: string, line: string): string {
  return createHash('sha1').update(machineId).update('|').update(line).digest('hex');
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
