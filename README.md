# Claude Terminal Harness

> A Nintendo-styled desktop control room for the [Claude Code](https://claude.com/claude-code) agents you run in your terminal.

Each agent you spawn becomes a Sims-style avatar living on a shared 2D office floor. You watch them walk between stations as they work, stream their real terminal output in a side panel, type prompts back to them, and browse their files and git history — all from one window.

<p align="center">
  <em>Electron · React · TypeScript · Pixi.js · xterm.js · node-pty</em>
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-FFD93D.svg?style=flat-square&labelColor=1A1320"></a>
  <img alt="Status: prototype" src="https://img.shields.io/badge/status-prototype-FF6B6B.svg?style=flat-square&labelColor=1A1320">
  <img alt="Platform: macOS" src="https://img.shields.io/badge/platform-macOS-4ECDC4.svg?style=flat-square&labelColor=1A1320">
</p>

> [!NOTE]
> **Status: working prototype.** The Electron shell, the office floor, real PTY terminals, and the file/git tooling are all functional. The *avatar behavior* (walking to stations based on which tool an agent is using) is currently driven by a synthetic event loop — see [Architecture](#architecture). Wiring it to real Claude Code hooks is the headline next milestone.

---

## Table of contents

- [What it is](#what-it-is)
- [Features](#features)
- [Screenshots](#screenshots)
- [Getting started](#getting-started)
- [Architecture](#architecture)
- [Project structure](#project-structure)
- [Design system](#design-system)
- [Configuration & data](#configuration--data)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgements](#acknowledgements)

---

## What it is

- An **Electron desktop app** (macOS-first) that gives you a single pane of glass over multiple Claude Code sessions.
- Each session runs as a real process in a **pseudo-terminal** (`node-pty`) owned by the app's main process. The raw byte stream is rendered with **xterm.js** — byte-for-byte authentic, ANSI and all.
- Each session is also an **avatar** on a Pixi.js "office floor." Avatars walk around, sit at desks, and visit stations.
- A side panel gives you, per agent: the live terminal, a command bar to type back into the session, a sandboxed **file browser + editor** (CodeMirror), and a **git tab** (status, log, commit graph, branches).

### What it is *not* (by design, for now)

- Not a replacement for the `claude` CLI — the CLI is the runtime, this app is the viewer/controller.
- Not a remote dashboard — local sessions only, no auth, no network surface.
- Not an agent-to-agent task scheduler — agents message each other (and you *see* an envelope fly desk-to-desk when they do), but the floor doesn't reassign or load-balance work between them yet.

---

## Features

| Area | What works today |
|---|---|
| **Real terminals** | Spawn any command (default: `claude`) in a `node-pty` PTY. Full read/write/resize/kill, live data + exit streaming over IPC, multi-agent. |
| **Office floor** | Pixi.js scene rendering a Tiled office map, camera, recolored character cast, pathfinding, seat assignment, and tool-bubble overlays. |
| **Message handoffs** | When the hive routes a message, an envelope flies from the sender's desk to each recipient (tinted by speech-act; escalations fly to the door) and pops an arrival sparkle — the multi-agent collaboration made visible. |
| **Agent panel** | Per-agent detail panel with terminal view, command bar, and a fullscreen terminal mode. |
| **File browser** | Sandboxed `listDir` / `readFile` / `writeFile` rooted at each agent's cwd, with a file tree and a syntax-highlighting CodeMirror editor (JS/TS, HTML, CSS, JSON, Markdown, Python, YAML). |
| **Git tab** | Branch, working-tree status, commit log, branch list, ahead/behind, and a rendered commit graph. |
| **Onboarding wizard** | First-run setup: pick a harness home, register repositories, choose default command and auto-mode. |
| **Safe quit** | Intercepts Cmd-Q and the red close button when live PTYs exist, and warns before killing them. |
| **Design system** | Fully tokenized SNES/Animal-Crossing aesthetic — pixel panels, buttons, badges, hand-drawn icons. See [`DESIGN.md`](./DESIGN.md). |
| **Avatar behavior** | ⚠️ Driven by a mock event loop (`mockEvents.ts`) — not yet wired to real Claude Code tool events. |

---

## Screenshots

> _Add screenshots/GIFs here._ A short screen recording of avatars walking between stations while a real `claude` session streams in the side panel is the best way to show what this is.

```
docs/
  floor.png         ← the office floor with avatars
  agent-panel.png   ← terminal + command bar + file/git tabs
```

---

## Getting started

### Prerequisites

- **macOS** (the app is macOS-first; Windows/Linux are untested).
- **Node.js 18+** and npm.
- A **C/C++ toolchain** for building `node-pty`'s native addon — on macOS, install the Xcode Command Line Tools:
  ```bash
  xcode-select --install
  ```
- **[Claude Code](https://claude.com/claude-code)** installed and on your `PATH` if you want agents to actually run `claude` (the default command). Any other command works too.

### Install & run

```bash
git clone <your-fork-url> claudeTerminalHarness
cd claudeTerminalHarness
npm install        # postinstall rebuilds node-pty against Electron's ABI
npm run dev        # launches the Electron app with hot reload
```

On first launch you'll go through the onboarding wizard, then land on an empty floor. Use **Add agent** to spawn your first session.

### Other scripts

```bash
npm run build      # production build via electron-vite
npm run preview    # preview the production build
npm run typecheck  # type-check both the node (main/preload) and web (renderer) projects
```

> If `node-pty` fails to load after an Electron upgrade, re-run `npm install` (the `postinstall` hook runs `electron-rebuild` against the current Electron ABI).

---

## Architecture

The load-bearing idea is **two data planes** feeding one renderer:

```
┌───────────────────────────────────────────────────────────────┐
│                     Electron Renderer (React)                  │
│   ┌──────────────────┐    ┌──────────────────────────────┐    │
│   │ Office Floor      │    │ Terminal + Command Bar       │    │
│   │ (Pixi.js)        │    │ Files + Git tabs (xterm.js)  │    │
│   └─────────▲────────┘    └────────────▲─────────────────┘    │
│             │ avatar state             │ pty bytes / fs / git  │
└─────────────┼──────────────────────────┼───────────────────────┘
              │ IPC (contextBridge: window.cth)                    
       ┌──────┴──────────┐        ┌──────┴─────────────┐
       │  Event Plane    │        │  Terminal Plane    │
       │  (mock today →  │        │  node-pty PTYs     │
       │   CC hooks v1)  │        │  + fs + git        │
       └─────────────────┘        └──────▲─────────────┘
                                         │ stdin / stdout
                                  ┌──────┴──────────────┐
                                  │  claude (or any cmd)│
                                  └─────────────────────┘
```

**Terminal plane (real).** The Electron main process owns a `PtyManager` that spawns each agent as a `node-pty` process, streams its output to the renderer over per-id IPC channels (`pty:data:<id>`), and accepts keystrokes back. The renderer never touches Node directly — everything goes through a typed `window.cth` bridge exposed in [`src/preload/index.ts`](./src/preload/index.ts). The same bridge exposes sandboxed filesystem and git helpers.

**Event plane (mocked).** Avatar state — _which station is this agent walking to, is it thinking/working/blocked_ — is currently produced by a synthetic loop in [`mockEvents.ts`](./src/renderer/src/store/mockEvents.ts). The intended v1 replacement is **Claude Code hooks** (`PreToolUse`, `PostToolUse`, `Notification`, `Stop`, …): a tiny shim CLI installed per project that POSTs hook payloads to a socket the main process listens on, so avatar movement reflects what the agent is _actually_ doing. See [`SPEC.md`](./SPEC.md) for the full design.

> **Note on the spec vs. the code:** [`SPEC.md`](./SPEC.md) originally described attaching to existing **tmux** panes. The implementation has since moved to spawning PTYs **directly** via `node-pty`, which removes the tmux dependency. Treat the code as the source of truth for the terminal plane; the spec remains the reference for the event plane and product vision.

---

## Project structure

```
src/
  main/                      Electron main process (Node)
    index.ts                 window, IPC handlers, quit guard
    pty.ts                   node-pty manager (spawn/write/resize/kill/stream)
    config.ts                harness config persistence + home setup
    fs.ts                    sandboxed listDir / readFile / writeFile
    git.ts                   branch / status / log / branches / ahead-behind
  preload/
    index.ts                 contextBridge → typed `window.cth` API
    index.d.ts               renderer-side type declarations
  renderer/
    index.html
    src/
      App.tsx                top-level layout + wiring
      design/                tokens.css / tokens.ts / global.css (source of truth)
      components/            PixelPanel, PixelButton, AgentDetailPanel, CommandBar,
                             TerminalView, FileTree, CodeEditor, GitTab, CommitGraph, …
      scene/office/          Pixi office floor: OfficeFloor, Character, Camera,
                             TiledMapRenderer, pathfinding, ToolBubble, cast, SeatPool
      store/                 zustand store + mock event loop + config types
      hooks/                 usePtyParser, useTypewriter
      assets/                tilesets, maps, character sheets (see ATTRIBUTION.md)
DESIGN.md                    canonical design system
SPEC.md                     product + architecture spec (event plane, vision)
```

---

## Design system

The aesthetic is **Animal Crossing × Earthbound × SNES menu UI** — pixel-snapped, chunky, friendly. [`DESIGN.md`](./DESIGN.md) is canonical; every component derives from its tokens. Highlights:

- Three fonts: **Press Start 2P** (display), **Pixelify Sans** (UI), **VT323** (terminal).
- **4 px** spacing grid, integer-only transforms, no CSS blur, no `border-radius`.
- SNES **three-layer panel borders** via nested `box-shadow inset`.
- Hard **4/4 drop shadows** — no soft shadows anywhere.
- Limited palette: ≤ 8 colors per screen, status communicated by **color + icon + avatar position** (never color alone).
- Tokens live in two synced files: `design/tokens.css` (CSS variables) and `design/tokens.ts` (TS objects for Pixi/inline styles).

---

## Configuration & data

App configuration is a small JSON document (`HarnessConfig`) managed by the main process and read through `window.cth.getConfig()`:

| Field | Meaning |
|---|---|
| `onboardingComplete` | Whether the first-run wizard has been finished. |
| `harnessHome` | Directory the harness uses as its home/workspace root. |
| `registeredRepos` | Repositories the user has registered. |
| `autoMode` | Toggles automatic behavior shown in the title bar. |
| `defaultCommand` | Command spawned for a new agent (default: `claude`). |

Filesystem and git access from the renderer is **sandboxed** — every `fs:*` and `git:*` IPC call is rooted at a given directory and validated in the main process, so the UI can only reach paths under an agent's working directory.

---

## Roadmap

Pulled from [`SPEC.md`](./SPEC.md) §11 and the current mock boundary:

- [ ] **Real event plane** — replace `mockEvents.ts` with Claude Code hooks so avatar movement reflects real tool use.
- [ ] **Hook shim CLI** — a small Node binary installed into a project's `.claude/settings.local.json` that POSTs hook payloads to a local socket owned by the app.
- [ ] **Add-agent flow** — pane/command picker + hook-install consent.
- [ ] **Config drawer** — per-agent goal, model, permission mode, skills, MCP (spec'd in `DESIGN.md` §7.9).
- [ ] **Notification round-trip** — approve/deny an agent's blocking prompt from the floor.
- [ ] **Persistence** — durable agents/layout/command history (SQLite).
- [ ] **Packaging** — signed `.dmg`; revisit Linux/Windows later.

---

## Contributing

Contributions are welcome — this is an early prototype, so there's a lot of surface area.

1. Fork and create a feature branch.
2. `npm install && npm run dev` to get a live build.
3. Keep the type-checker green: `npm run typecheck`.
4. Match the existing aesthetic — **any new UI must derive from [`DESIGN.md`](./DESIGN.md) tokens**, not ad-hoc colors or spacing.
5. Open a PR describing the change and, for anything visual, include a screenshot or short clip.

Good first areas: wiring real hook events, the add-agent flow, the config drawer, and cross-platform smoke-testing.

---

## License

> [!IMPORTANT]
> **Asset licensing:** the bundled pixel art (tilesets, maps, and the base character sheets that the Office cast is recolored from) comes from [LimeZu](https://limezu.itch.io/) via [`shahar061/the-office`](https://github.com/shahar061/the-office) and is distributed under the **LimeZu FREE VERSION license — non-commercial use only**. The recolored sprites are derivative edits and inherit that restriction. See [`src/renderer/src/assets/ATTRIBUTION.md`](./src/renderer/src/assets/ATTRIBUTION.md). **If you commercialize this project, you must replace these assets or obtain a paid LimeZu license.**

The **source code** is licensed under the **MIT License** — see [`LICENSE`](./LICENSE). The MIT grant covers the code only; the non-commercial asset restriction above is carved out from it in the `LICENSE` file's scope note.

---

## Acknowledgements

- [LimeZu](https://limezu.itch.io/) — pixel-art tilesets and character base sheets.
- [`shahar061/the-office`](https://github.com/shahar061/the-office) — office tileset/map and walk-sheet vendoring (project code: ISC).
- [Pixi.js](https://pixijs.com/), [xterm.js](https://xtermjs.org/), [node-pty](https://github.com/microsoft/node-pty), [electron-vite](https://electron-vite.org/), [CodeMirror](https://codemirror.net/) — the libraries this is built on.
