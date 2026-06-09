# Get set up — `rp-agent-harness`

A step-by-step guide for a RealPage teammate who just cloned this repo and wants it
running. Follow **one** track — [macOS](#macos) or [Windows](#windows) — top to
bottom. Each is self-contained.

When you're done you'll have the Electron app running locally, with `claude`
agents you can spawn and an orchestrator that coordinates them. Everything is
**local-first** — team sync (Supabase) and shared semantic memory (Ollama) are
optional add-ons covered at the end.

> **Heads-up about the RealPage network:** Palo Alto Prisma inspects TLS and
> presents a **RealPage-signed certificate** for outbound HTTPS. Node/npm don't
> trust that CA by default, so installs fail with `SELF_SIGNED_CERT_IN_CHAIN`
> until you do the one-time cert step below. **Do that step first** — most setup
> failures trace back to skipping it.

> **Tip:** clone to a plain local path (`~/Code`, `C:\Code`), **not** a
> cloud-synced folder (OneDrive, iCloud, Dropbox). Background sync locks or
> de-hydrates `node_modules` files mid-build.

---

## macOS

### 0. Trust the RealPage CA (one time per machine)

Installs that download native build headers and the Electron runtime will fail
without this.

```bash
# 1. Export the RealPage CA chain from the macOS keychain into a PEM file.
CA="$HOME/.realpage-ca.pem"
security find-certificate -a -p -c "RealPage" /Library/Keychains/System.keychain > "$CA"
security find-certificate -a -p -c "RealPage" /System/Library/Keychains/SystemRootCertificates.keychain >> "$CA"

# 2. Point npm at it (persists in ~/.npmrc).
npm config set cafile "$CA"

# 3. Point Node itself at it for downloads that don't read npm's config
#    (e.g. the Electron runtime). Add to ~/.zshrc so it sticks.
echo 'export NODE_EXTRA_CA_CERTS="$HOME/.realpage-ca.pem"' >> ~/.zshrc
export NODE_EXTRA_CA_CERTS="$HOME/.realpage-ca.pem"
```

Do **not** use `npm config set strict-ssl false` — trusting the corporate CA is
the correct, scoped fix.

> If `security find-certificate` returns nothing, your CA may be named slightly
> differently — open **Keychain Access**, search "RealPage", and confirm the
> exact name, then re-run with that string.

### 1. Prerequisites

| Tool | Install | Check |
|------|---------|-------|
| **Xcode Command Line Tools** (C/C++ toolchain for native addons) | `xcode-select --install` | `xcode-select -p` |
| **Node.js 22 LTS** (22+ recommended) | `brew install node@22`, or [nodejs.org](https://nodejs.org), or `nvm install 22` | `node -v` |
| **git** | ships with the Xcode tools above | `git --version` |
| **Claude Code** on your `PATH` | follow [claude.com/claude-code](https://claude.com/claude-code), then run `claude` once and sign in | `claude --version` |

> **Node 24 note:** Node 24 works — the repo's `postinstall` auto-heals a known
> Electron-runtime extract bug — but Node 22 LTS avoids it entirely.

### 2. (Optional) Ollama — for shared semantic memory

The harness embeds agent memory **locally** via Ollama (HuggingFace downloads are
blocked on the RealPage network, so nothing leaves your machine). Skip this if you
only want plain markdown memory.

```bash
brew install ollama          # or download from https://ollama.com
ollama serve                 # start the local server (leave running; or use the menu-bar app)
ollama pull nomic-embed-text # the 768-dim embedding model the harness uses
```

> If `ollama pull` fails with a TLS error on the corporate network, run it off
> the VPN once (the model caches locally), or point Ollama at the same CA.

### 3. Clone and install

```bash
git clone https://github.com/realpage-cole/rp-agent-harness.git
cd rp-agent-harness
npm install   # postinstall rebuilds native deps (node-pty) + heals the Electron runtime
```

### 4. Run

```bash
npm run dev   # launches the Electron app with hot reload
```

Continue to [First launch](#first-launch).

---

## Windows

Use **PowerShell** (not Command Prompt) for these steps. Run the cert + build-tool
steps in a PowerShell window opened **as Administrator**; the clone/install can be
a normal window.

### 0. Trust the RealPage CA (one time per machine)

```powershell
# 1. Export every RealPage cert from the machine + root stores into one PEM file.
$ca = "$env:USERPROFILE\.realpage-ca.pem"
Get-ChildItem Cert:\LocalMachine\Root, Cert:\LocalMachine\CA |
  Where-Object { $_.Subject -like "*RealPage*" } |
  ForEach-Object {
    "-----BEGIN CERTIFICATE-----"
    [Convert]::ToBase64String($_.RawData, [Base64FormattingOptions]::InsertLineBreaks)
    "-----END CERTIFICATE-----"
  } | Set-Content -Encoding ascii $ca

# 2. Point npm at it (persists in your user .npmrc).
npm config set cafile $ca

# 3. Point Node itself at it for downloads that don't read npm's config
#    (e.g. the Electron runtime). setx persists it for future shells.
setx NODE_EXTRA_CA_CERTS "$ca"
$env:NODE_EXTRA_CA_CERTS = $ca   # also set it for THIS shell
```

Do **not** use `npm config set strict-ssl false` — trusting the corporate CA is
the correct, scoped fix.

> `setx` only affects **new** shells, which is why we also set `$env:` for the
> current one. Open a fresh PowerShell window after this step.
>
> If the `Get-ChildItem` filter returns nothing, open **certmgr.msc**, find the
> RealPage CA under *Trusted Root* / *Intermediate*, and confirm the subject name,
> then adjust the `-like "*RealPage*"` filter.

### 1. Prerequisites

| Tool | Install | Check |
|------|---------|-------|
| **Visual Studio Build Tools 2022** with the **"Desktop development with C++"** workload (MSVC + Windows SDK — needed by `node-gyp` for `node-pty`/`better-sqlite3`) | [visualstudio.microsoft.com/downloads](https://visualstudio.microsoft.com/downloads/) → *Build Tools for Visual Studio* | (installed via the VS Installer) |
| **Python 3** (node-gyp dependency) | `winget install Python.Python.3.12` or [python.org](https://www.python.org) | `python --version` |
| **Node.js 22 LTS** (22+ recommended) | `winget install OpenJS.NodeJS.LTS`, [nodejs.org](https://nodejs.org), or [nvm-windows](https://github.com/coreybutler/nvm-windows) | `node -v` |
| **git** | `winget install Git.Git` or [git-scm.com](https://git-scm.com) | `git --version` |
| **Claude Code** on your `PATH` | follow [claude.com/claude-code](https://claude.com/claude-code), then run `claude` once and sign in | `claude --version` |

> **Node 24 note:** Node 24 works — the repo's `postinstall` auto-heals a known
> Electron-runtime extract bug — but Node 22 LTS avoids it entirely.

### 2. (Optional) Ollama — for shared semantic memory

The harness embeds agent memory **locally** via Ollama (HuggingFace downloads are
blocked on the RealPage network, so nothing leaves your machine). Skip this if you
only want plain markdown memory.

1. Download **OllamaSetup.exe** from [ollama.com](https://ollama.com) and install it
   (it runs a background server automatically).
2. In PowerShell, pull the embedding model:
   ```powershell
   ollama pull nomic-embed-text
   ```

> If `ollama pull` fails with a TLS error on the corporate network, run it off the
> VPN once (the model caches locally).

### 3. Clone and install

```powershell
git clone https://github.com/realpage-cole/rp-agent-harness.git
cd rp-agent-harness
npm install   # postinstall rebuilds native deps (node-pty) + heals the Electron runtime
```

### 4. Run

```powershell
npm run dev   # launches the Electron app with hot reload
```

Continue to [First launch](#first-launch).

---

## First launch

On first launch you'll go through a short **onboarding wizard**:

1. **Harness home** — a folder where the app keeps its state (the hive, logs,
   agent memory). Pick a plain local path.
2. **Registered repos** — folders you commonly work in (used as quick-picks when
   spawning agents).
3. **Default command** — `claude` (the default). Auto-mode adds the
   bypass-permissions flag.

Then you land on the **Hive dashboard**. Click **Add agent** to spawn your first
session; the orchestrator (**god**) agent coordinates the team. You talk to god,
it decomposes work and fans it out.

---

## Optional: team sync + shared semantic memory (Supabase)

Everything above runs fully offline. To share a hive, a team blackboard, and the
**shared semantic memory** with teammates, enable Supabase sync:

1. **Ollama running** (step 2 of your OS track) — embeddings are produced locally
   and stored in the team's Supabase `pgvector` index. Without sync + sign-in, the
   semantic memory stays local-only/no-op, but markdown memory still works.
2. **A Supabase project** with the migrations in `supabase/migrations/` applied,
   Email auth enabled, and a user created.
3. In the app: **Settings → Sync** → toggle on, paste the Supabase **URL** +
   **anon key**, sign in, then **create or join a workspace** (share the workspace
   id with teammates).

The full Supabase walkthrough — what syncs, auth/RLS, and the migration order — is
in the main **[README → Collaborative memory (Supabase)](README.md#collaborative-memory-supabase)**.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `npm install` fails with `SELF_SIGNED_CERT_IN_CHAIN` / TLS errors | You skipped (or mis-ran) **step 0**. Re-export the CA and confirm `npm config get cafile` and `NODE_EXTRA_CA_CERTS` both point to your PEM. |
| App launches to a blank/"Electron uninstall" window | Electron runtime extract was truncated (Node 24 bug). Re-run `npm install` — `postinstall` heals it. |
| `NODE_MODULE_VERSION` mismatch or "wrong ELF/Mach-O" at launch | Native addon ABI mismatch. Confirm your C/C++ toolchain (Xcode CLT / VS Build Tools) is installed, then re-run `npm install` (re-triggers `electron-rebuild`). |
| `node-pty` / `better-sqlite3` build errors during install | Missing build toolchain — macOS: `xcode-select --install`; Windows: VS Build Tools "Desktop development with C++" + Python 3. |
| `claude: command not found` when spawning an agent | Claude Code isn't on your `PATH`, or you haven't signed in. Run `claude` in a terminal once and authenticate. |
| Memory panel says "Ollama not reachable" | Start Ollama (`ollama serve` / the app) and confirm `ollama pull nomic-embed-text` succeeded. Memory panel still needs team sync on + signed in to be fully active. |
| Weird build locks / vanishing `node_modules` | You're in a cloud-synced folder. Move the repo to a plain local path and reinstall. |

---

## Where to read more

- **[README.md](README.md)** — what the harness is, architecture, the hive, the
  dashboard, and the full Supabase + semantic-memory design.
- **[README → Run and build](README.md#run-and-build)** — `dev` / `build` /
  `typecheck` / `dist` commands.
