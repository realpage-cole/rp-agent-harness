/**
 * MemoryManager — semantic memory for the hive, backed by the MemPalace CLI.
 *
 * CLI-only (no MCP): the harness keeps a single shared palace under harnessHome,
 * points every agent's `MEMPALACE_PALACE_PATH` at it, and mines each agent's
 * `memory.md` into its own wing so the whole team can recall by meaning via
 * `mempalace search` / `mempalace wake-up`. Degrades silently to no-op when the
 * `mempalace` CLI isn't installed — the markdown memory still works.
 *
 *   init    : mempalace init <home> --yes --no-llm        (heuristics-only, no LLM)
 *   store   : mempalace mine <agentDir> --wing <id> --agent <id>
 *   recall  : mempalace search "<q>" --results N   /   mempalace wake-up
 *
 * Runs in the Electron main process.
 */
import { existsSync, statSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/** Non-memory files `mempalace mine` must not ingest: the Claude Code hooks
 *  config (a large JSON blob that swamps the wake-up digest), the cursor, and
 *  raw inbox/outbox message JSON. `mempalace mine` honors .gitignore, so we drop
 *  one in each agent dir rather than touch the mine command. */
const MINE_IGNORE_LINES = ['settings.json', 'cursor.json', 'inbox/', 'outbox/'];

/** Idempotently ensure `<agentDir>/.gitignore` excludes the non-memory files.
 *  Writes only the missing lines (append-only) so it's safe to call every cycle. */
function ensureMineIgnore(agentDir: string): void {
  const path = join(agentDir, '.gitignore');
  let existing = '';
  try { if (existsSync(path)) existing = readFileSync(path, 'utf8'); } catch { return; }
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = MINE_IGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return; // already covered — don't rewrite every cycle
  const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
  try { writeFileSync(path, prefix + missing.join('\n') + '\n', 'utf8'); } catch { /* best-effort */ }
}

export type EmbeddingModel = 'minilm' | 'embeddinggemma';

export interface MemorySettings {
  enabled: boolean;
  model: EmbeddingModel;
}

export interface MemoryStatus {
  available: boolean;        // mempalace CLI found on PATH
  enabled: boolean;          // user setting
  active: boolean;           // available && enabled && have a home
  initialized: boolean;      // palace directory exists
  palacePath: string | null;
  model: EmbeddingModel;
  bin: string | null;
}

const MINE_INTERVAL_MS = 180_000; // re-mine changed memories every 3 min

export class MemoryManager {
  private binCache: string | null | undefined;
  private mineTimer: NodeJS.Timeout | null = null;
  private initStarted = false;
  /** True while a mineNow() pass is in flight — serializes palace writers. */
  private mining = false;
  /** agentDir (absolute path) → memory.md mtimeMs at last successful mine (skip
   *  unchanged). Keyed by full path so the own (`agents/<id>`) and mirrored
   *  (`mirror/agents/<id>`) copies of one agent never collide. */
  private lastMined = new Map<string, number>();

  constructor(
    private getHome: () => string | null,
    private getSettings: () => MemorySettings
  ) {}

  palacePath(): string | null {
    const h = this.getHome();
    return h ? join(h, 'palace') : null;
  }

  /** Resolve the mempalace CLI against the user's PATH + common uv/pip spots. */
  bin(): string | null {
    if (this.binCache !== undefined) return this.binCache;
    let found: string | null = null;
    const isWin = process.platform === 'win32';
    // 1) Ask the shell/PATH resolver. Windows has no POSIX shell + uses `where`
    //    and a `.exe` suffix; everything else goes through the login shell.
    try {
      if (isWin) {
        const res = spawnSync('where', ['mempalace'], { encoding: 'utf8', timeout: 3000 });
        const p = res.stdout.trim().split(/\r?\n/)[0]?.trim();
        if (p && existsSync(p)) found = p;
      } else {
        const res = spawnSync(process.env.SHELL ?? '/bin/zsh', ['-ilc', 'which mempalace'], {
          encoding: 'utf8', timeout: 3000
        });
        const p = res.stdout.trim().split('\n').pop();
        if (p && existsSync(p)) found = p;
      }
    } catch { /* fall through */ }
    // 2) Probe common install locations (uv tool / homebrew / pip).
    if (!found) {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
      const candidates = isWin
        ? [
            join(home, '.local', 'bin', 'mempalace.exe'),
            join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Scripts', 'mempalace.exe')
          ]
        : [
            `${home}/.local/bin/mempalace`,
            '/opt/homebrew/bin/mempalace',
            '/usr/local/bin/mempalace'
          ];
      for (const c of candidates) if (c && existsSync(c)) { found = c; break; }
    }
    this.binCache = found;
    return found;
  }
  /** Force re-resolution (e.g. after the user installs mempalace). */
  resetBinCache(): void { this.binCache = undefined; }

  available(): boolean { return this.bin() !== null; }
  enabled(): boolean { return this.getSettings().enabled; }
  active(): boolean { return this.available() && this.enabled() && this.getHome() !== null; }
  model(): EmbeddingModel { return this.getSettings().model === 'embeddinggemma' ? 'embeddinggemma' : 'minilm'; }

  status(): MemoryStatus {
    const palace = this.palacePath();
    return {
      available: this.available(),
      enabled: this.enabled(),
      active: this.active(),
      initialized: !!palace && existsSync(palace),
      palacePath: palace,
      model: this.model(),
      bin: this.bin()
    };
  }

  /** Env merged into each agent's spawn so its `mempalace` CLI hits the shared palace. */
  env(): Record<string, string> {
    const palace = this.palacePath();
    if (!this.active() || !palace) return {};
    return { MEMPALACE_PALACE_PATH: palace, MEMPALACE_EMBEDDING_MODEL: this.model() };
  }

  private childEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      MEMPALACE_PALACE_PATH: this.palacePath() ?? '',
      MEMPALACE_EMBEDDING_MODEL: this.model()
    };
  }

  // — lifecycle —

  /** Start the mine loop. `mempalace mine` auto-creates the palace on first run
   *  (lazily downloading the embedding model, one-time). We deliberately do NOT
   *  run `mempalace init`: it ends in an interactive "Mine now? [Y/n]" prompt
   *  that --yes doesn't cover, so a spawned child would hang forever. */
  start(): void {
    if (!this.active() || this.initStarted) return;
    if (!this.bin() || !this.getHome() || !this.palacePath()) return;
    this.initStarted = true;
    this.startMineLoop();
  }

  stop(): void {
    if (this.mineTimer) { clearInterval(this.mineTimer); this.mineTimer = null; }
  }

  private startMineLoop(): void {
    if (this.mineTimer) return;
    this.mineNow();
    this.mineTimer = setInterval(() => this.mineNow(), MINE_INTERVAL_MS);
  }

  // — mining (store) —

  /** Mine every agent whose memory changed since last time, one at a time.
   *  The palace permits a single writer, so mines MUST be serialized — firing
   *  them concurrently makes all but one fail with "held by another writer".
   *  `mining` guards against a slow pass overlapping the next interval tick.
   *
   *  Two source trees are mined, both serialized under the same `mining` guard:
   *    - `hive/agents/<id>`        — this machine's OWN agents.
   *    - `hive/mirror/agents/<id>` — teammates' memory pulled in by SyncManager
   *      (Phase 2). Mining these makes the whole team recallable locally. Pull
   *      writes ONLY the mirror tree and push scans ONLY the agents tree, so the
   *      two are disjoint and can't echo. */
  async mineNow(): Promise<void> {
    const home = this.getHome();
    const bin = this.bin();
    if (!this.active() || !home || !bin) return;
    if (this.mining) return; // a previous pass is still running — let it finish
    this.mining = true;
    try {
      await this.mineTree(join(home, 'hive', 'agents'));
      await this.mineTree(join(home, 'hive', 'mirror', 'agents'));
    } finally {
      this.mining = false;
    }
  }

  /** Mine every agent under one source tree whose memory.md changed since the
   *  last pass, one writer at a time. The caller holds the `mining` guard across
   *  all trees so the single-writer palace is never contended. The `lastMined`
   *  mtime cache is keyed by the full agentDir path, so an `agents/<id>` and a
   *  `mirror/agents/<id>` of the same id never collide. */
  private async mineTree(agentsDir: string): Promise<void> {
    if (!existsSync(agentsDir)) return;
    let ids: string[];
    try { ids = readdirSync(agentsDir); } catch { return; }
    for (const id of ids) {
      const agentDir = join(agentsDir, id);
      const mem = join(agentDir, 'memory.md');
      if (!existsSync(mem)) continue;
      let mtime = 0;
      try { mtime = statSync(mem).mtimeMs; } catch { continue; }
      if (this.lastMined.get(agentDir) === mtime) continue; // unchanged — skip the model load
      this.lastMined.set(agentDir, mtime);
      await this.mineAgent(agentDir, id); // one writer at a time
    }
  }

  private mineAgent(agentDir: string, id: string): Promise<void> {
    return new Promise((resolve) => {
      const bin = this.bin();
      if (!bin) { resolve(); return; }
      ensureMineIgnore(agentDir); // keep settings.json / cursor / messages out of the index
      // stdin closed (mempalace can prompt); mempalace dedups so re-mining is safe.
      const proc = spawn(bin, ['mine', agentDir, '--wing', id, '--agent', id], {
        env: this.childEnv(), stdio: ['ignore', 'ignore', 'pipe']
      });
      let err = '';
      proc.stderr?.on('data', (d) => { err += d.toString(); });
      proc.on('close', (code) => {
        if (code !== 0) {
          console.error(`[memory] mine ${id} exited ${code}: ${err.slice(-300)}`);
          this.lastMined.delete(agentDir); // let the next tick retry
        }
        resolve();
      });
      proc.on('error', () => { this.lastMined.delete(agentDir); resolve(); });
    });
  }

  // — recall (read) —

  /** Semantic search across the shared palace. Returns the CLI's text output. */
  search(query: string, opts: { wing?: string; results?: number } = {}): { ok: boolean; output: string; error?: string } {
    const bin = this.bin();
    if (!this.active() || !bin) return { ok: false, output: '', error: 'semantic memory not active' };
    const args = ['search', query, '--results', String(opts.results ?? 5)];
    if (opts.wing) args.push('--wing', opts.wing);
    const res = spawnSync(bin, args, { env: this.childEnv(), encoding: 'utf8', timeout: 120_000, input: '' });
    if (res.status !== 0) return { ok: false, output: res.stdout ?? '', error: (res.stderr || 'search failed').trim() };
    return { ok: true, output: res.stdout ?? '' };
  }

  /** Session-start digest (~600-900 tokens). */
  wakeUp(wing?: string): { ok: boolean; output: string; error?: string } {
    const bin = this.bin();
    if (!this.active() || !bin) return { ok: false, output: '', error: 'semantic memory not active' };
    const args = ['wake-up'];
    if (wing) args.push('--wing', wing);
    const res = spawnSync(bin, args, { env: this.childEnv(), encoding: 'utf8', timeout: 120_000, input: '' });
    if (res.status !== 0) return { ok: false, output: res.stdout ?? '', error: (res.stderr || 'wake-up failed').trim() };
    return { ok: true, output: res.stdout ?? '' };
  }
}
