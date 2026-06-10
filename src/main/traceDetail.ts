/**
 * Trace detail — full tool-call payloads for the per-agent traces view.
 *
 * The live span ring buffer (telemetry.ts) carries only metadata (tool name,
 * success, duration) — NO payloads. For the dashboard's detail view we mine the
 * agent's Claude Code transcript instead: each assistant `tool_use` block paired
 * with its matching `tool_result` gives the full input + output. Read-only and
 * best-effort: an unreadable/missing transcript yields [] and never throws into
 * the IPC layer.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir } from './transcript';

/** One tool invocation with its full input/output payload. Newest-first. */
export interface TraceEvent {
  id: string;
  ts: number;
  tool: string;
  /** One-line summary: bash→the command; read/write/edit→the file path; else the tool name. */
  title: string;
  input: string;
  output: string;
  success: boolean;
  durationMs?: number;
  truncated: boolean;
}

const MAX_PAYLOAD = 50_000;

/** Anything that resolves an agentId → its working directory (the hive registry). */
export type CwdResolver = (agentId: string) => string | null;
/** Resolves an agentId → its current Claude session id (from live telemetry), or
 *  null when unknown. The transcript filename IS the session id, so this is what
 *  lets us read the SELECTED agent's session — not whichever was last active. */
export type SessionResolver = (agentId: string) => string | null;

interface JsonlRecord {
  type?: unknown;
  timestamp?: unknown;
  message?: { content?: unknown };
}

interface ToolUseBlock {
  type: 'tool_use';
  id?: string;
  name?: string;
  input?: unknown;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id?: string;
  content?: unknown;
  is_error?: unknown;
}

/** Pretty-print a tool's input object to a string, capped downstream. */
function prettyInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** Flatten a tool_result `content` (string OR array of {type:'text',text}) to text. */
function resultText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object') {
          const part = b as { type?: unknown; text?: unknown };
          if (typeof part.text === 'string') return part.text;
        }
        try { return JSON.stringify(b); } catch { return ''; }
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object') {
    try { return JSON.stringify(content, null, 2); } catch { return ''; }
  }
  return String(content);
}

/** One-line summary per the contract: bash→command; read/write/edit→file path;
 *  else the tool name. Case-insensitive on the tool name. */
function titleFor(tool: string, input: unknown): string {
  const t = tool.toLowerCase();
  const obj = (input && typeof input === 'object') ? (input as Record<string, unknown>) : {};
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  if (t === 'bash') {
    const cmd = str(obj.command);
    if (cmd) return cmd.split('\n')[0];
  }
  if (t === 'read' || t === 'write' || t === 'edit' || t === 'multiedit' || t === 'notebookedit') {
    const fp = str(obj.file_path) ?? str(obj.path) ?? str(obj.notebook_path);
    if (fp) return fp;
  }
  return tool;
}

function cap(s: string): { text: string; truncated: boolean } {
  if (s.length <= MAX_PAYLOAD) return { text: s, truncated: false };
  return { text: s.slice(0, MAX_PAYLOAD), truncated: true };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Parse a record timestamp (ISO string or epoch) to ms epoch; 0 when absent. */
function tsOf(rec: JsonlRecord): number {
  const t = rec.timestamp;
  if (typeof t === 'number') return t;
  if (typeof t === 'string') {
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

/** The newest `.jsonl` by mtime among `files` under `dir`, or null. */
function newestOf(dir: string, files: string[]): string | null {
  let best: { path: string; mtime: number } | null = null;
  for (const f of files) {
    const full = join(dir, f);
    try {
      const mtime = statSync(full).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: full, mtime };
    } catch { /* skip unstatable file */ }
  }
  return best?.path ?? null;
}

/**
 * Resolve the transcript file for THIS agent's session — the crux of keeping
 * traces agent-specific when multiple agents share one cwd (one project dir, one
 * `<sessionId>.jsonl` per session):
 *   1. exact `<sessionId>.jsonl` when telemetry knows the agent's session;
 *   2. else the only file, when the cwd has just one session (unambiguous);
 *   3. else, ONLY when the session is unknown (telemetry off / not seen yet),
 *      the newest file as a best-effort — never when a session is known but its
 *      file is absent, since that would surface another agent's transcript.
 */
function resolveTranscript(cwd: string, sessionId: string | null): string | null {
  const dir = projectDir(cwd);
  if (!existsSync(dir)) return null;
  if (sessionId) {
    const exact = join(dir, `${sessionId}.jsonl`);
    if (existsSync(exact)) return exact;
  }
  let files: string[];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return null; }
  if (files.length === 0) return null;
  if (files.length === 1) return join(dir, files[0]); // single session — unambiguous
  if (sessionId) return null; // known agent session, no matching file → don't leak another's
  return newestOf(dir, files); // session unknown → best-effort newest
}

/**
 * Return the agent's tool-call traces (newest-first), each with full input/output
 * payloads mined from its newest Claude Code transcript. Best-effort: missing or
 * unreadable transcript → []. Never throws.
 *
 * @param agentId           the hive agent id
 * @param resolveCwd        maps the agent id → its cwd (the hive registry)
 * @param resolveSessionId  maps the agent id → its live session id (telemetry)
 * @param limit             max events to return (default 200)
 */
export function traceDetails(
  agentId: string,
  resolveCwd: CwdResolver,
  resolveSessionId: SessionResolver,
  limit = 200
): TraceEvent[] {
  try {
    const cwd = resolveCwd(agentId);
    if (!cwd) return [];
    const path = resolveTranscript(cwd, resolveSessionId(agentId));
    if (!path) return [];

    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch { return []; }

    // First pass: index every tool_result by its tool_use_id so we can pair them.
    const results = new Map<string, { text: string; success: boolean }>();
    const uses: Array<{ id: string; tool: string; input: unknown; ts: number }> = [];

    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: JsonlRecord;
      try { rec = JSON.parse(trimmed); } catch { continue; }
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      const ts = tsOf(rec);
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: unknown };
        if (b.type === 'tool_use') {
          const tu = block as ToolUseBlock;
          uses.push({
            id: typeof tu.id === 'string' ? tu.id : '',
            tool: typeof tu.name === 'string' ? tu.name : 'tool',
            input: tu.input,
            ts
          });
        } else if (b.type === 'tool_result') {
          const tr = block as ToolResultBlock;
          if (typeof tr.tool_use_id === 'string') {
            results.set(tr.tool_use_id, {
              text: resultText(tr.content),
              success: tr.is_error !== true
            });
          }
        }
      }
    }

    const events: TraceEvent[] = uses.map((u) => {
      const res = u.id ? results.get(u.id) : undefined;
      const inRaw = prettyInput(u.input);
      const outRaw = res?.text ?? '';
      const input = cap(inRaw);
      const output = cap(outRaw);
      return {
        id: u.id || `${u.tool}-${u.ts}`,
        ts: u.ts,
        tool: u.tool,
        title: titleFor(u.tool, u.input),
        input: input.text,
        output: output.text,
        success: res ? res.success : true,
        truncated: input.truncated || output.truncated
      };
    });

    // Newest-first. Records carry an ascending timestamp; for equal/zero stamps,
    // transcript order is chronological so reverse-index breaks ties.
    events.sort((a, b) => (b.ts - a.ts) || 0);
    return events.slice(0, Math.max(0, num(limit) || 200));
  } catch {
    return [];
  }
}
