# rp-agent-harness

**A local multi-agent harness for [Claude Code](https://claude.com/claude-code).** `rp-agent-harness` is an internal RealPage desktop app (Electron + React + TypeScript) that turns the `claude` CLI sessions you already run in your terminal into a self-coordinating team. Each agent runs as a real Claude Code process in a pseudo-terminal, gets long-term memory and a mailbox, and is coordinated by a **god orchestrator agent** you talk to. A modern Hive dashboard shows the agent roster, a live activity feed, a task board, and a "needs you" queue for the items that require your input. Everything is local-first; an optional Supabase layer lets teammates share long-term memory and a team blackboard, and view each other's roster + task board read-only.

> 🚀 **Just cloned this and want it running?** Start with **[GET-SETUP.md](GET-SETUP.md)** — a guided, copy-paste setup with separate **macOS** and **Windows** tracks (including the one-time RealPage corporate-network cert step). This README is the reference; that's the on-ramp.

## Table of contents

- [What it is](#what-it-is)
- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
  - [RealPage corporate network setup](#realpage-corporate-network-setup)
  - [Clone and install](#clone-and-install)
- [Run and build](#run-and-build)
- [Architecture](#architecture)
  - [Three Electron processes](#three-electron-processes)
  - [The Hive — on-disk coordination layer](#the-hive--on-disk-coordination-layer)
  - [The orchestrator (god agent) and human-in-the-loop](#the-orchestrator-god-agent-and-human-in-the-loop)
  - [Memory](#memory)
- [The dashboard](#the-dashboard)
- [Collaborative memory (Supabase)](#collaborative-memory-supabase)
  - [What syncs](#what-syncs)
  - [Auth, workspaces, and RLS](#auth-workspaces-and-rls)
  - [Setup](#setup)
- [Contributing](#contributing)
  - [Security](#security)
- [License](#license)
- [Changelog](#changelog)

## What it is

`rp-agent-harness` is a desktop app for running and coordinating a team of Claude Code agents on your own machine. Instead of juggling several terminal sessions by hand, you spawn agents in the app, talk to a single **orchestrator** ("god") agent, and let it decompose work and fan it out to the others. The agents coordinate through an on-disk **hive** — a single git-backed folder of plain files — so the whole team shares memory, a mailbox, a blackboard, and a task ledger.

It is local-first by design: everything runs on your machine and works fully offline. An optional Supabase layer lets a team share one logical hive across machines while each machine keeps its local files as the source of truth.

## Features

- **Multi-agent Claude Code harness.** Every agent is a real `claude` session running in a `node-pty` pseudo-terminal — full read/write/resize/kill, live streaming over IPC, multiple agents at once. Additional providers are supported, including an Antigravity (Gemini) worker and a Codex preset; hookless providers receive hive mail as a terminal work order rather than a full inbox-drain.
- **Orchestrator + hive coordination.** The on-disk "hive" is a single-committer, git-backed coordination layer: per-agent identity and long-term memory, atomic-file mailboxes (`outbox/` → routed into `inbox/`), a shared blackboard, and an append-only event log. A god orchestrator agent (id `god`, role `orchestrator`) adjudicates traffic, routes and assigns tasks, and parks human-blocking items in a "needs you" queue. No agent ever touches git directly, which avoids `.git/index.lock` corruption.
- **Modern Hive dashboard.** The main view composes an agent roster, a live activity feed, a dependency-aware kanban task board, and a "needs you" banner, with quick-nav into the Command Center tabs (Tasks, Schedules, Needs you). All bindings — tasks, human queue, messages, agent status — are real, live data.
- **Optional Supabase collaborative sync.** Off by default. When enabled, Supabase becomes a shared "upstream" the local hive never had: an append-only mirror of the event log, cost ledger, and command history; two-way agent-memory sync; a **shared team blackboard**; and **per-owner roster + kanban** — your hive stays your own (your orchestrator only manages your agents), and a unified **Viewing** toggle switches the dashboard to a teammate's roster + board read-only. It runs entirely in the Electron main process and is layered on top of the local hive — local files under `<harnessHome>/hive/` stay the source of truth and the app remains fully functional offline. Backed by Supabase Auth (email/password), Row-Level Security, and workspaces; migrations live in `supabase/migrations/`.
- **Shared semantic memory (local embeddings).** Long-term agent memory is markdown-first and works on its own. On top of that, durable facts in every agent's `memory.md` are embedded — **locally, via [Ollama](https://ollama.com) (`nomic-embed-text`)**, because RealPage's network policy blocks the usual HuggingFace model downloads — and the vectors are stored in the team's **Supabase `pgvector`** index. The result is one shared semantic memory across teammates, sessions, and projects: search it by meaning from the UI, and the more the team records, the better future sessions get. This is the living/breathing layer of the harness. It degrades silently to a no-op when Ollama isn't running or sync is off (plain markdown memory still works).
- **Durability and control.** A SQLite-backed durable store (window bounds + history) and a durable cost ledger that survive restarts; a cost/runaway circuit breaker (steer → constrain → stop); per-agent token budgets and real token/cost telemetry read from `~/.claude/projects/` transcripts; live OpenTelemetry-based observability; a memory-condensation reflector; optional per-agent git worktree isolation; recurring scheduled missions (an hourly ops standup ships enabled); GitHub issue/CI ingestion via the `gh` CLI; and desktop notifications.

## Requirements

- **Node.js** and **npm** (Node 22+ recommended; see the Node 24 note under Install).
- **[Claude Code](https://claude.com/claude-code)** on your `PATH` so agents can run `claude` (the default command). Any other command works too.
- A **C/C++ toolchain** for the native addons (`node-pty`, `better-sqlite3`). On macOS, install the Xcode Command Line Tools:
  ```bash
  xcode-select --install
  ```
- *Optional:* [Ollama](https://ollama.com) running locally with the embedding model pulled (`ollama pull nomic-embed-text`), for shared semantic memory. HuggingFace model downloads are blocked on the RealPage network, so embeddings run entirely through local Ollama — nothing leaves your machine to produce a vector. The app works without it; markdown memory still functions.
- *Optional:* a Supabase project (URL + anon/publishable key + workspace) for collaborative team sync, configured in the app's settings.

## Install

> Prefer a guided, OS-specific walkthrough? **[GET-SETUP.md](GET-SETUP.md)** has full **macOS** and **Windows** tracks. The steps below are the reference (macOS commands shown).

### RealPage corporate network setup

On the RealPage network, Palo Alto Prisma performs TLS inspection and presents a **RealPage-signed certificate** for outbound HTTPS. Node and npm don't trust that CA out of the box, so `npm install` fails in `postinstall` with `SELF_SIGNED_CERT_IN_CHAIN` when `node-gyp`/`electron-rebuild` and the `electron` package try to download native build headers and the Electron runtime. Do this **once per machine** before installing:

```bash
# 1. Export the RealPage CA chain from the macOS keychain into a PEM file.
CA="$HOME/.realpage-ca.pem"
security find-certificate -a -p -c "RealPage" /Library/Keychains/System.keychain > "$CA"
security find-certificate -a -p -c "RealPage" /System/Library/Keychains/SystemRootCertificates.keychain >> "$CA"

# 2. Point npm at it (persists in ~/.npmrc).
npm config set cafile "$CA"

# 3. Point Node itself at it, for downloads that don't read npm's config
#    (e.g. the Electron runtime). Add to ~/.zshrc so it sticks.
echo 'export NODE_EXTRA_CA_CERTS="$HOME/.realpage-ca.pem"' >> ~/.zshrc
export NODE_EXTRA_CA_CERTS="$HOME/.realpage-ca.pem"
```

Do **not** use `npm config set strict-ssl false` — trusting the corporate CA is the correct, scoped fix.

> **Node 24 note:** the `electron` installer unpacks its runtime with a library that silently truncates the extract on Node 24, leaving an unlaunchable app ("Electron uninstall"). This repo's `postinstall` runs `tools/ensure-electron.cjs`, which detects the broken extract and re-unpacks the runtime with the OS `unzip` automatically — no action needed. It's a no-op on Node versions where the bug isn't present.

> **Tip:** clone to a plain local path (e.g. `~/Code`), not a cloud-synced folder like OneDrive — background sync can lock or de-hydrate `node_modules` files mid-build.

### Clone and install

```bash
git clone https://github.com/realpage-cole/rp-agent-harness.git
cd rp-agent-harness
npm install        # postinstall rebuilds native deps (node-pty) + heals the Electron runtime extract
```

> The most common setup failure is the native `node-pty` rebuild. The `postinstall` hook runs `electron-rebuild` so `node-pty` matches Electron's ABI. If you hit a `NODE_MODULE_VERSION` or "wrong ELF/Mach-O" error at launch, confirm your C/C++ toolchain is installed and re-run `npm install` (which re-triggers `postinstall`).

## Run and build

```bash
npm run dev        # launch the Electron app with hot reload
```

On first launch you'll go through the onboarding wizard (harness home, registered repos, default command, auto-mode), then land on the Hive dashboard. Use **Add agent** to spawn your first session; the orchestrator (god) agent runs the team automatically.

```bash
npm run build      # production build via electron-vite
npm run preview    # preview the production build
npm run typecheck  # type-check the main/preload (node) and renderer (web) projects

npm run dist       # build, then package for the current OS via electron-builder
npm run dist:mac   # macOS .dmg (universal)
npm run dist:win   # Windows NSIS installer + portable .exe (x64)
npm run dist:linux # Linux AppImage (x64)
```

## Architecture

`rp-agent-harness` is an Electron app with the standard three-process split, plus an on-disk coordination layer (the **Hive**) that the agents share. The agents themselves are real CLI processes — they are the *intelligence*; the main process is the *mechanism* (git, sockets, routing, the PTYs).

### Three Electron processes

- **Main (Node).** Owns everything privileged: it spawns each agent as a `node-pty` child and streams its output over per-id IPC, runs the Hive coordination layer (`src/main/hive.ts`), hosts the hook server that agents call back into (`src/main/hooks.ts`), runs the shared semantic-memory layer (local Ollama embeddings in `src/main/memory/ollama.ts`, read/searched via `src/main/memory.ts`), and drives the optional Supabase sync (`src/main/sync/*`).
- **Preload.** A thin `contextBridge` that exposes a single typed `window.cth` API to the renderer (`src/preload/index.ts`). The renderer never touches Node, IPC channels, the filesystem, or git directly — only this bridge.
- **Renderer (React).** The modern **Hive dashboard** (`src/renderer/src/components/dashboard/*`): an agent roster, a live activity feed, a dependency-aware kanban task board, and a "needs you" queue for items waiting on a human. It also hosts the per-agent terminals (xterm.js over the PTY bytes). It is a pure view over state the main process owns.

### The Hive — on-disk coordination layer

Everything the team knows is plain files in one local git repo under `<harnessHome>/hive/`. Two rules make this safe under many concurrent agents:

- **Single committer.** Only the Electron main process ever runs git (commit with retry/backoff and stale-lock recovery). Agents never call git — they just read and write files. This avoids `.git/index.lock` corruption.
- **Single-writer-per-file.** Each agent writes only inside its own `agents/<id>/` directory. Cross-agent delivery is done by the **router** (in the main process), which moves messages out of a sender's `outbox/` and into the recipient's `inbox/`. No file is ever written by two processes.

Layout:

```
hive/
  PROTOCOL.md          agent-facing contract (how to remember + message)
  COMMANDS.md          CLI / slash-command reference the orchestrator consults
  registry.json        roster: every agent — role, capabilities, status, session id
  board.md             shared blackboard / co-authored plans (orchestrator is sole scribe)
  tasks.json           kanban task ledger (id, assignee, status, dependsOn, humanQA, …)
  log.jsonl            append-only event feed (drives the dashboard activity stream)
  agents/<id>/
    identity.md        who am I, my role, my capabilities  (refreshed each spawn)
    memory.md          my long-term memory  (read at task start, appended as I learn)
    inbox/             messages delivered TO me — one JSON file per message
    inbox/.done/       processed messages, kept for audit (not deleted)
    outbox/            messages I want to SEND — the router drains these
    cursor.json        { lastProcessed } — so a message is surfaced exactly once
```

Each message is one JSON file written via temp-file + atomic rename, never a co-edited mailbox. `log.jsonl` is append-only and consumers track their own cursor. `board.md` is the one genuinely co-edited file, so all writes go through the orchestrator as the single scribe.

**The router** polls every `outbox/` (cheap and robust versus `fs.watch`, default ~1.5s), normalizes each message, delivers it to the recipient's `inbox/`, appends to `log.jsonl`, and commits — all in the main process. Messages addressed to `"god"`, `"broadcast"`, or `"human"` are resolved here (a `"human"` message routes to the orchestrator, the human's proxy on the team). A hop cap stops two agents from ping-ponging forever.

### The orchestrator (god agent) and human-in-the-loop

One always-on privileged agent is the **orchestrator**, also called the **god agent** (its id is `god`, flagged `isGod` in the registry). It is an ordinary agent process — the intelligence — that owns the team-level work:

- **Roster & routing** (`registry.json`) — who exists, their capabilities and status.
- **Delegation** — decompose work and fan it out to worker agents via their inboxes as self-contained task contracts; it does not do the grunt work itself.
- **Blackboard scribe** — the single writer of `board.md`, so shared plans never conflict.
- **Task ledger** (`tasks.json`) — assign, track, retry, and mark done; an assignee stays on a card so the board reads as who-did-what.

There is **no separate approval queue**. Human-in-the-loop is native to each agent's own Claude Code session: tool-permission prompts are the gate, and they can be approved remotely (e.g. from a phone via `/remote-control`). When a task can only proceed with a human's input — a question or an action only a person can take — the orchestrator marks the card `blocked` and appends the ask to the card's `humanQA` array; the dashboard surfaces these in the **needs you** queue, and the answer flows back both onto the card and as an inbox message to the orchestrator.

Autonomy comes from a `Stop` hook: when an agent finishes a turn, the hook checks its inbox via the main process and, if there are unread messages, returns `{"decision":"block", …}` to keep the agent working (guarded against infinite loops by `stop_hook_active` and the per-agent cursor).

### Memory

- **Markdown first (always on).** Every agent has a `memory.md` it reads at the start of a task and appends to as it learns, plus the shared `board.md`. This is the durable memory of the team and needs nothing beyond the filesystem.
- **Shared semantic memory (Ollama + pgvector).** On top of the markdown, durable facts are made recallable *by meaning* across the whole team. Each agent's `memory.md` is chunked and embedded **locally via Ollama** (`nomic-embed-text`, 768-dim) — nothing leaves the machine to produce a vector — and the chunks are upserted into a workspace-scoped **Supabase `pgvector`** table (`memory_chunks`). Search embeds your query locally too, then runs a cosine top-K (the `match_memory_chunks` RPC) across the entire team's memory. **Why not the usual sentence-transformers / MemPalace path?** Those models are fetched from HuggingFace, which the RealPage network blocks — so the harness embeds through local Ollama instead. This is the living/breathing layer of the harness: the more the team writes to memory, the smarter recall gets over time. Embedding **writes** ride the Supabase sync beat (`src/main/sync/memory.ts`); **reads** (search / wake-up) go through `src/main/memory.ts` and the Memory panel. Because the index lives in Supabase, semantic memory needs sync on + signed in; markdown memory always works regardless, and embedding degrades to a silent no-op when Ollama is unreachable.

## The dashboard

The main pane is a modern **Hive dashboard**. It composes four live, real-data panels plus quick-nav into the Command Center:

- **Team roster** (left) — one card per agent: avatar, name, a status badge (`idle` / `working` / `blocked` / `gone`, plus `compacting`/`looping` states), and a current-action line (live action, falling back to the last prompt). The god/orchestrator card is tagged **LEAD**. Clicking a card selects that agent and drives the right-hand detail sidebar.
- **Task board** (center) — a kanban of the hive ledger in **To do / Doing / Blocked / Done** columns, with per-column counts and cards showing title + assignee (or a **needs you** flag). Any card or the header opens the Command Center's **Tasks** tab.
- **Activity feed** (right) — routed hive messages newest-first ("X asked Y", "X informed the team", etc.), rendered from the live message stream; human escalations are highlighted and framed toward "… You".
- **Needs-you banner** (top) — appears only when the orchestrator has parked one or more questions for the human; it shows the count and an **Answer →** button into the Command Center's **human** tab.

A header row provides quick-nav buttons (**Tasks**, **Schedules**, **Needs you**) into the **Command Center** tabs — the per-agent control surface for tasks, scheduled missions, and the human-in-the-loop queue. It also has a **Viewing** selector: it shows *your* hive by default, but switch it to a teammate and the **roster + task board both flip to that teammate's, read-only** (your local board is never touched). The blackboard (Command Center → **activity**) stays the one shared team board.

## Collaborative memory (Supabase)

`rp-agent-harness` is **local-first**. Every machine's hive lives on disk under `<harnessHome>/hive/` (a single-committer git repo of plain files), and the harness is fully functional offline. Supabase sync is an **optional layer bolted on top** — the shared "upstream" the local git repo never had. Turn it off and nothing changes locally; the local files stay the source of truth.

When enabled, a `SyncManager` running in the Electron **main process** (the workspace token must never reach the renderer, and the renderer's CSP blocks `supabase.co`/`wss`) push/pulls on a 60s beat plus a 30s catch-up poll for shared state. `@supabase/supabase-js` is loaded by dynamic import, so a missing dependency just leaves sync inactive instead of breaking boot. Sync is a complete no-op unless `syncEnabled`, a Supabase URL, an anon key, and a workspace id are all set *and* a user is signed in.

### What syncs

- **Append-only event mirror (one-way up).** Three sinks are tailed from byte/id cursors and upserted with a deterministic dedup key, so a crash or cursor reset can never double-insert:
  - `<hive>/log.jsonl` → `public.hive_log`
  - `<hive>/cost-ledger.jsonl` → `public.cost_ledger`
  - the SQLite `command_history` table → `public.command_history`
- **Per-agent memory (two-way).** Each owned agent's `<hive>/agents/<id>/memory.md` is hashed and pushed to `public.agent_memory` (keyed on `workspace_id, agent_id`) when it changes. Teammates' rows are pulled into `<hive>/mirror/agents/<id>/memory.md`. Push scans `agents/`, pull writes `mirror/agents/` — disjoint paths, so there's no echo loop. One agent lives on one machine, so there's no merge: last-write-wins by `updated_at`. (The markdown body is the source of truth; the semantic index below is derived from it.)
- **Shared semantic memory (embeddings).** On the same push pass, when an owned agent's `memory.md` changes it is chunked, embedded **locally via Ollama** (`nomic-embed-text`), and the vectors are upserted into `public.memory_chunks` (keyed per `workspace_id, machine_id, agent_id, chunk_id`, membership-scoped RLS). Recall is a cosine top-K over the whole workspace via the `match_memory_chunks` RPC — so a query you run locally is answered from *everyone's* memory. A separate per-agent embed cursor means an Ollama outage never blocks text sync (and vice versa); each retries independently. HuggingFace is network-blocked, so embeddings are local-only by design.
- **Per-owner roster & kanban (push-only).** Your roster (`registry.json` → `public.agents`) and task kanban (`tasks.json` → `public.tasks`) are pushed up tagged with your machine id + owner label, but a teammate's are **never merged into your local hive** — your board stays yours and your orchestrator only manages your own agents. Both tables are keyed per machine (`workspace_id, machine_id, …`) so teammates' hives can't collide (notably every orchestrator is `agent_id='god'`). A teammate's roster + kanban are viewed **read-only, on demand** via the dashboard's **Viewing** toggle (`listHiveOwners` / `teammateAgents` / `teammateTasks`).
- **Shared blackboard (live, two-way).** Only `board.md` (→ `public.board`, one row per workspace) is genuinely shared. It syncs across machines via **Supabase Realtime** (`postgres_changes`) backed by the 30s catch-up poll, **last-writer-wins by `updated_at`**. It's the team's single coordination surface, with the orchestrator as its sole scribe.

Cursors and the per-machine id live in the local SQLite kv store, so they survive restarts. Every pass is best-effort and independent — one sink or table failing never blocks the others, and a failed pass simply retries on the next beat.

### Auth, workspaces, and RLS

Sync is gated on **Supabase Auth (email/password)** and a **workspace**:

- `public.workspaces` (one row per team) and `public.workspace_members` (which users belong to which workspace).
- A `SECURITY DEFINER` helper `is_workspace_member(ws)` that every data table's RLS consults; `EXECUTE` on it is granted to authenticated users only.
- Every data table is **authenticated-only and membership-scoped**: a row is readable/writable only by signed-in members of its workspace. Deletes are denied on the append-only / additive tables; `memory_chunks` is the one exception — a member may delete-then-reinsert their own chunks when an agent's memory is re-embedded.

There are two clients in the main process: a dedicated **auth client** (`signInWithPassword` / `setSession` / `signOut`) and a **data client** built with an `accessToken` callback so every DB call carries the session token and RLS sees `auth.uid()`. The session (access + refresh tokens) lives **only** in the main process and the local kv store — it never crosses IPC; the renderer only ever sees a tokenless snapshot (signed in or not, and who). A returning user's session is restored on launch, so sync arms immediately.

### Setup

1. **Apply the schema.** Point the project at a Supabase project (`supabase/config.toml` carries the public `project_id`), then apply the migrations in `supabase/migrations/` — via `supabase db push`, the Supabase SQL editor, or the GitHub integration. They run in order: append-only mirror → agent memory → shared state → auth + RLS, then the RLS hardening/fix, per-owner-key, and shared-semantic-memory (`pgvector` + `memory_chunks` + `match_memory_chunks`) migrations. The last one enables the `vector` extension; no extra setup beyond that.
2. **Enable Email auth and create a user.** In the Supabase dashboard, turn on the Email auth provider and create at least one user (or allow sign-ups) — there's no in-app sign-up; the harness signs in an existing account.
3. **Configure the harness.** Open **Settings → Sync**. Toggle sync on, paste your **Supabase URL** and **anon key** (Supabase project → Settings → API).
4. **Sign in.** Enter your email + password and click **sign in**.
5. **Create or join a workspace.** Either **create** one (give it a name) or **join** an existing one (paste its workspace id). The id is persisted as your `syncWorkspaceId` and stamped on every synced row. Share that id with teammates so they can join the same hive.
6. **Start.** Click **start**. Sync only runs once you're signed in *and* a workspace is set; everything is scoped to that team.

> **Known caveat — migration history vs. repo filenames.** A hosted project's applied migration history may not match the repo filenames one-to-one (timestamps can differ, and one migration name differs by suffix). The **schema is equivalent**, but `supabase db push` / `supabase migration list` may report drift. Reconcile by version if you re-link the project.

## Contributing

`rp-agent-harness` is an internal RealPage tool and an early prototype, so there's a lot of surface area and plenty of room to help.

**Development setup.** Follow [Requirements](#requirements) and [Install](#install) above. On the RealPage corporate network, do the one-time [CA-trust setup](#realpage-corporate-network-setup) before `npm install`, otherwise the native rebuild and Electron-runtime download fail with `SELF_SIGNED_CERT_IN_CHAIN`. The app is developed macOS-first; Windows and Linux are exercised in CI and have platform-specific code paths, and cross-platform fixes are welcome.

**Before you open a PR:**

1. **Keep the type-checker green:** `npm run typecheck` runs both TypeScript projects — `typecheck:node` (main/preload/shared, `tsconfig.node.json`) and `typecheck:web` (the React renderer, `tsconfig.web.json`). Both are `strict`. This is the de-facto CI gate; there is no test suite yet.
2. **Confirm a production build works:** `npm run build` (electron-vite). The CI build job exercises the native `node-pty` rebuild and is allowed to fail without blocking; typecheck is the gate that must stay green.
3. **For anything visual, include a screenshot or short clip** in the PR.

CI runs on every push and PR to `main` (`.github/workflows/ci.yml`): a `typecheck` job (the gate) plus a best-effort `build` job, both on `macos-latest` with Node 20. Tagged `v*` pushes trigger `release.yml`, which builds and publishes per-platform installers.

**Branch & PR flow:**

- Branch off `main`; keep each PR focused on a single change.
- Write a clear PR description of *what* changed and *why*, and link any related issue (`Closes #123`).
- Don't commit `node_modules/`, `out/`, or built artifacts (already gitignored).
- Bug reports and feature requests use the issue forms under `.github/ISSUE_TEMPLATE/`; blank issues are disabled.

As an internal RealPage project, this follows RealPage's standard code of conduct and engineering norms — be respectful and constructive.

### Security

`rp-agent-harness` is a local-first desktop app. It spawns local processes in PTYs and reads/writes files only under directories you register, sandboxed and path-validated in the main process. The renderer has no direct Node access (`nodeIntegration: false`, `contextIsolation: true`); all `fs:*` / `git:*` IPC is typed through a `contextBridge` (`window.cth`) and rooted at an agent's working directory. The hive commits to a local git repo from a single committer (the main process); agents only write plain files. The only network listener is a local socket (or named pipe on Windows) for the hook server.

When optional Supabase collaborative sync is enabled, Supabase Auth tokens live **only** in the main process (never crossing IPC to the renderer), and workspace access is enforced server-side with Row-Level Security — a client only sees rows for workspaces it belongs to.

Because this is an internal tool, **report security issues privately** to the maintainer rather than opening a public issue or PR — include a description, reproduction steps, and impact.

## License

See [LICENSE](./LICENSE).

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for the full version history.
