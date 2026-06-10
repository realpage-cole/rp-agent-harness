/**
 * ThoughtsService — the harness-driven "agent board" author.
 *
 * Twice a day (11:00 + 15:00 America/Chicago) this service gathers a compact
 * digest of the hive's RECENT WORK — recently completed tasks, the tails of each
 * agent's memory.md, and the latest log.jsonl events — and asks a cheap headless
 * Claude (Haiku) for 1-3 short, FORWARD-LOOKING project/feature ideas grounded in
 * that work. Each fire appends one entry to the shared "agent" Notepad board via
 * syncManager.appendBoardEntry({ board:'agent', authorKind:'agent', ... }).
 *
 * Mirrors MemoryReflector: an in-process timer service (start()/stop()) that runs
 * in the Electron main process and uses runHiddenClaude. Everything is
 * best-effort — a missing home, an empty digest, sync being off, or an LLM
 * failure all skip silently; nothing here ever throws.
 *
 * Scheduling is DST-aware (see scheduleNext / nextCentralFireMs): the next 11:00
 * or 15:00 Central is computed via Intl in the America/Chicago zone and converted
 * to a UTC epoch, recomputed after each fire so a DST shift just lands the next
 * timer correctly.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runHiddenClaude } from './hiddenClaude';

/** Cheap idea generator — quality bar is low (short bullets), so Haiku is fine. */
const THOUGHTS_MODEL = 'claude-haiku-4-5';
/** Hard cap so a wedged headless run can't stall the schedule. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Central wall-clock hours the service fires at (DST-aware). */
const FIRE_HOURS = [11, 15];
/** Total digest budget — cap the gathered recent-work context (~12 KB). */
const DIGEST_BUDGET_BYTES = 12 * 1024;
/** Per-source caps so one giant file can't crowd out the others. */
const MAX_TASKS = 12;
const MAX_LOG_LINES = 40;
const MEMORY_TAIL_BYTES = 2 * 1024;

/** Instruction prefix — byte-identical across calls so Claude Code prompt-caches
 *  it; the dynamic digest goes in the tail. */
const THOUGHTS_SYSTEM = [
  "You are a product strategist reviewing one engineering team's recent work.",
  'Below is a compact digest: recently completed tasks, the tails of each agent\'s',
  'memory, and recent activity-log events. From it, propose 1-3 CONCISE,',
  'FORWARD-LOOKING project or feature ideas that build naturally on what the team',
  'has been doing — concrete next steps or adjacent opportunities, NOT a summary',
  'of past work.',
  'RULES:',
  '- Output ONLY short markdown bullets (`- ...`), 1 to 3 of them, one idea each.',
  '- Each bullet: one sentence, specific and actionable, grounded in the digest.',
  '- No preamble, no heading, no closing remarks — just the bullets.'
].join('\n');

/** A minimal HiveTask shape — only the fields the digest reads. */
interface DigestTask {
  status?: string;
  title?: string;
  assignee?: string;
  result?: string;
}

export class ThoughtsService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  /** True while a fire is in flight — serializes so a slow LLM pass can't overlap
   *  a (re)scheduled fire. */
  private firing = false;

  /**
   * @param getHome  Lazily resolve harnessHome so the digest follows config.
   * @param getCommand The base `claude` command (only its binary name is used).
   * @param isEnabled  Master gate (config.agentThoughtsEnabled, default true).
   * @param canRun     Sync is on + signed in (the agent board is shared).
   * @param append     Appends one agent-board entry (wraps appendBoardEntry).
   */
  constructor(
    private getHome: () => string | null,
    private getCommand: () => string,
    private isEnabled: () => boolean,
    private canRun: () => boolean,
    private append: (body: string) => Promise<{ ok: boolean; error?: string }>
  ) {}

  // — lifecycle (mirrors MemoryReflector) —

  start(): void {
    if (this.started) return;
    if (!this.isEnabled()) return;
    this.started = true;
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.started = false;
  }

  /** Arm a one-shot timer for the next 11:00/15:00 Central. Recomputed after each
   *  fire so a DST boundary just lands the next timer correctly. */
  private scheduleNext(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const ms = Math.max(1_000, nextCentralFireMs(Date.now()) - Date.now());
    this.timer = setTimeout(() => { void this.fire(); }, ms);
  }

  // — one fire —

  /** Gather the recent-work digest and, only if there is activity AND sync can
   *  run, append 1-3 forward-looking ideas to the agent board. Always reschedules
   *  the next fire. Best-effort — never throws. */
  async fire(): Promise<void> {
    try {
      if (!this.isEnabled() || this.firing) return;
      this.firing = true;
      try {
        const home = this.getHome();
        if (!home) return;
        // The agent board is SHARED — skip silently unless sync is up + signed in.
        if (!this.canRun()) return;
        const digest = this.gatherDigest(home);
        if (!digest.trim()) return; // no recent activity → nothing to riff on
        const body = await this.brainstorm(home, digest);
        if (!body) return;
        try { await this.append(body); } catch { /* best-effort */ }
      } finally {
        this.firing = false;
      }
    } catch { /* never throw out of the timer */ }
    finally {
      if (this.started) this.scheduleNext();
    }
  }

  // — digest (recent done tasks + memory.md tails + recent log) —

  /** Build a compact ~12 KB digest of the hive's recent work. Returns '' when
   *  there's no hive / nothing recent. Best-effort throughout. */
  private gatherDigest(home: string): string {
    const root = join(home, 'hive');
    if (!existsSync(root)) return '';
    const parts: string[] = [];
    let budget = DIGEST_BUDGET_BYTES;

    // 1) Recently 'done' tasks (tasks.json) — the clearest "what shipped" signal.
    const done = this.recentDoneTasks(root);
    if (done.length) {
      const lines = done.map((t) => {
        const who = t.assignee ? ` (${t.assignee})` : '';
        const res = t.result ? ` — ${t.result}` : '';
        return `- ${t.title ?? 'untitled'}${who}${res}`;
      });
      const block = ['## Recently completed tasks', ...lines].join('\n');
      const trimmed = clip(block, budget);
      if (trimmed) { parts.push(trimmed); budget -= Buffer.byteLength(trimmed, 'utf8'); }
    }

    // 2) The tail of each agent's memory.md (most recent context per agent).
    if (budget > 0) {
      const memBlocks = this.memoryTails(root, budget);
      if (memBlocks) { parts.push(memBlocks); budget -= Buffer.byteLength(memBlocks, 'utf8'); }
    }

    // 3) Recent log.jsonl events (low-signal but cheap continuity).
    if (budget > 0) {
      const log = this.recentLog(root, budget);
      if (log) { parts.push(log); }
    }

    return parts.join('\n\n').trim();
  }

  /** Up to MAX_TASKS most-recent 'done' tasks from tasks.json. Best-effort: []. */
  private recentDoneTasks(root: string): DigestTask[] {
    try {
      const raw = readFileSync(join(root, 'tasks.json'), 'utf8');
      const parsed = JSON.parse(raw) as { tasks?: unknown } | unknown[];
      const list = Array.isArray(parsed) ? parsed : (parsed as { tasks?: unknown }).tasks;
      if (!Array.isArray(list)) return [];
      const done = list
        .filter((t): t is DigestTask => !!t && typeof t === 'object' && (t as DigestTask).status === 'done');
      // tasks.json is roughly creation-ordered; take the tail (most recent).
      return done.slice(-MAX_TASKS);
    } catch { return []; }
  }

  /** Concatenated tails of each agent's memory.md, capped to `budget`. */
  private memoryTails(root: string, budget: number): string {
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return '';
    let ids: string[];
    try { ids = readdirSync(agentsDir); } catch { return ''; }
    const blocks: string[] = [];
    let left = budget;
    for (const id of ids) {
      if (left <= 0) break;
      const mem = join(agentsDir, id, 'memory.md');
      try {
        if (!existsSync(mem)) continue;
        const text = readFileSync(mem, 'utf8');
        const tail = text.slice(-MEMORY_TAIL_BYTES).trim();
        if (!tail) continue;
        const block = `### memory: ${id}\n${tail}`;
        const trimmed = clip(block, left);
        if (trimmed) { blocks.push(trimmed); left -= Buffer.byteLength(trimmed, 'utf8'); }
      } catch { continue; }
    }
    if (!blocks.length) return '';
    return ['## Agent memory tails', ...blocks].join('\n\n');
  }

  /** The last MAX_LOG_LINES events from log.jsonl, one compact line each. */
  private recentLog(root: string, budget: number): string {
    try {
      const raw = readFileSync(join(root, 'log.jsonl'), 'utf8');
      const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
      const tail = lines.slice(-MAX_LOG_LINES);
      const summarized: string[] = [];
      for (const line of tail) {
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          const kind = typeof ev.kind === 'string' ? ev.kind : 'event';
          const bits = [kind];
          if (typeof ev.agentId === 'string') bits.push(ev.agentId);
          if (typeof ev.subject === 'string') bits.push(ev.subject);
          summarized.push(`- ${bits.join(' · ')}`);
        } catch { /* skip malformed line */ }
      }
      if (!summarized.length) return '';
      const block = ['## Recent activity', ...summarized].join('\n');
      return clip(block, budget);
    } catch { return ''; }
  }

  // — the headless LLM call (the only non-deterministic step) —

  /** Ask Haiku for 1-3 forward-looking idea bullets grounded in the digest.
   *  Returns the trimmed markdown bullets, or '' on any failure. */
  private async brainstorm(home: string, digest: string): Promise<string> {
    const prompt = [
      THOUGHTS_SYSTEM,
      '',
      '--- RECENT WORK DIGEST ---',
      digest
    ].join('\n');

    let result;
    try {
      result = await runHiddenClaude(prompt, {
        model: THOUGHTS_MODEL,
        cwd: home,
        command: this.getCommand(),
        // Pure text generation — must never touch the repo or shell out.
        disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Bash'],
        timeoutMs: DEFAULT_TIMEOUT_MS
      });
    } catch { return ''; }
    if (!result.ok || !result.text) return '';
    return cleanBullets(result.text);
  }
}

// ─── pure helpers (deterministic, unit-testable) ─────────────────────────────

/** Clip `text` to at most `budget` UTF-8 bytes (on a line boundary where it can),
 *  or '' when budget is non-positive. */
export function clip(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= budget) return text;
  // Trim line-by-line from the end until it fits — keeps whole lines intact.
  const lines = text.split('\n');
  while (lines.length > 1 && Buffer.byteLength(lines.join('\n'), 'utf8') > budget) {
    lines.pop();
  }
  const joined = lines.join('\n');
  if (Buffer.byteLength(joined, 'utf8') <= budget) return joined;
  // Single oversized line — hard-cut by characters (a loose byte approximation).
  return joined.slice(0, budget);
}

/** Normalize the model's output to clean markdown bullets: strip a code fence,
 *  drop blank/preamble lines, keep at most the first 3 bullet lines. '' if none. */
export function cleanBullets(raw: string): string {
  let text = raw.trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/, '').trim();
  const bullets: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^[-*]\s+\S/.test(t)) bullets.push(`- ${t.replace(/^[-*]\s+/, '')}`);
    if (bullets.length >= 3) break;
  }
  return bullets.join('\n');
}

/** The next 11:00 or 15:00 America/Chicago wall-clock instant, as a UTC epoch
 *  (ms), strictly AFTER `nowMs`. DST-aware: the target wall-clock time is resolved
 *  to a UTC epoch by computing the zone's offset at a first guess and re-applying
 *  it once — which settles for every case except the rare instant inside a DST
 *  transition (acceptable for a twice-a-day idea generator). Always returns a
 *  future epoch (rolls to the next valid slot, including tomorrow's 11:00). */
export function nextCentralFireMs(nowMs: number): number {
  const ZONE = 'America/Chicago';
  // Central wall-clock components for "now".
  const parts = centralParts(nowMs, ZONE);
  // Candidate fire instants: today's 11:00 and 15:00 Central, plus tomorrow's
  // 11:00 (covers the after-15:00 case). Resolve each wall time → UTC epoch.
  const candidates: number[] = [];
  for (const dayOffset of [0, 1]) {
    for (const hour of FIRE_HOURS) {
      candidates.push(centralWallToUtc(
        { year: parts.year, month: parts.month, day: parts.day + dayOffset, hour },
        ZONE
      ));
    }
  }
  const future = candidates.filter((t) => t > nowMs).sort((a, b) => a - b);
  // Fallback (should never hit): one hour out.
  return future[0] ?? nowMs + 3_600_000;
}

/** Central wall-clock {year, month(1-12), day, hour} for a given UTC epoch. */
function centralParts(ms: number, zone: string): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric'
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) map[p.type] = p.value;
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

/** Convert a Central wall-clock target ({year, month(1-12), day, hour}, minute=0)
 *  to a UTC epoch (ms). Computes the zone offset at a first UTC guess and applies
 *  it; one settle pass handles standard/DST offsets. `day` may overflow its month
 *  (Date normalizes it). */
function centralWallToUtc(
  target: { year: number; month: number; day: number; hour: number },
  zone: string
): number {
  // First guess: treat the wall time as if it were UTC.
  const guess = Date.UTC(target.year, target.month - 1, target.day, target.hour, 0, 0);
  // Offset (ms) the zone has at that instant = (wall clock there) - (UTC).
  const offset = zoneOffsetMs(guess, zone);
  // The true UTC epoch is the guess minus that offset.
  return guess - offset;
}

/** The zone's UTC offset (ms) at a given UTC instant: positive east of UTC,
 *  negative west (so Central is negative). Derived by formatting the instant in
 *  the zone and diffing against the same fields read as UTC. */
function zoneOffsetMs(ms: number, zone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hour12: false,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric'
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) map[p.type] = p.value;
  let hour = Number(map.hour);
  if (hour === 24) hour = 0; // Intl can emit '24' at midnight
  const asUtc = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day), hour,
    Number(map.minute), Number(map.second)
  );
  return asUtc - ms;
}
