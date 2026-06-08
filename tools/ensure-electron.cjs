#!/usr/bin/env node
'use strict';
/**
 * Guarantee the Electron runtime binary is fully extracted.
 *
 * The `electron` package's own postinstall (node_modules/electron/install.js)
 * downloads the ~100 MB runtime zip and unpacks it with `extract-zip`. Under
 * Node 24 that library silently stops after the FIRST zip entry: it resolves
 * its promise cleanly (install.js exits 0) but `node_modules/electron/dist/`
 * ends up with only `LICENSES.chromium.html` — no `Electron.app`, no `path.txt`.
 * `require('electron')` then throws "Electron failed to install correctly" and
 * electron-vite reports "Electron uninstall", so the app never launches.
 *
 * This detects an incomplete `dist/` and re-extracts the SAME cached zip with
 * the OS unzip tool (which handles the archive correctly), then writes the
 * `path.txt` pointer install.js would have written. It's a no-op once Electron
 * is correctly installed, so it costs nothing when the upstream bug is gone.
 *
 * Best-effort: any failure warns and exits 0 — it must never break `npm install`
 * (a broken extract already leaves the app unlaunchable; we don't make it worse).
 */
const { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, renameSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const ELECTRON_DIR = join(__dirname, '..', 'node_modules', 'electron');

/** Mirror electron/install.js getPlatformPath(): the in-dist path to the binary. */
function platformPath() {
  switch (process.env.npm_config_platform || process.platform) {
    case 'mas':
    case 'darwin': return 'Electron.app/Contents/MacOS/Electron';
    case 'freebsd':
    case 'openbsd':
    case 'linux': return 'electron';
    case 'win32': return 'electron.exe';
    default: return null;
  }
}

/** Already-correct install: dist/version matches package, path.txt is right, binary exists. */
function isInstalled(version, relPath) {
  try {
    if (readFileSync(join(ELECTRON_DIR, 'dist', 'version'), 'utf-8').replace(/^v/, '') !== version) return false;
    if (readFileSync(join(ELECTRON_DIR, 'path.txt'), 'utf-8') !== relPath) return false;
    return existsSync(join(ELECTRON_DIR, 'dist', relPath));
  } catch {
    return false;
  }
}

/** Unpack `zip` into `dir` with the OS tool — `extract-zip` is the thing that's broken. */
function osUnzip(zip, dir) {
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-q', '-o', zip, '-d', dir], { stdio: 'inherit' });
  }
}

(async () => {
  try {
    if (!existsSync(ELECTRON_DIR)) process.exit(0); // electron not a dep here
    const relPath = platformPath();
    if (!relPath) process.exit(0); // unknown platform — leave it to electron
    const { version } = require(join(ELECTRON_DIR, 'package.json'));

    if (isInstalled(version, relPath)) {
      console.log('[ensure-electron] runtime already extracted');
      process.exit(0);
    }

    // Resolve the runtime zip via @electron/get — it returns the cached path, or
    // downloads it (honoring NODE_EXTRA_CA_CERTS) if the cache is gone. It may be
    // nested under electron or hoisted to the project root depending on npm.
    let getMod;
    try { getMod = require(join(ELECTRON_DIR, 'node_modules', '@electron', 'get')); }
    catch { getMod = require('@electron/get'); }
    const { downloadArtifact } = getMod;
    let checksums;
    try { checksums = require(join(ELECTRON_DIR, 'checksums.json')); } catch { /* optional */ }
    const zipPath = await downloadArtifact({
      version, artifactName: 'electron', checksums,
      platform: process.env.npm_config_platform || process.platform,
      arch: process.env.npm_config_arch || process.arch,
    });

    const distDir = join(ELECTRON_DIR, 'dist');
    rmSync(distDir, { recursive: true, force: true });
    mkdirSync(distDir, { recursive: true });
    osUnzip(zipPath, distDir);

    // install.js hoists the bundled type defs up to the package root.
    const srcTypes = join(distDir, 'electron.d.ts');
    if (existsSync(srcTypes)) renameSync(srcTypes, join(ELECTRON_DIR, 'electron.d.ts'));

    writeFileSync(join(ELECTRON_DIR, 'path.txt'), relPath);

    if (existsSync(join(distDir, relPath))) {
      console.log('[ensure-electron] re-extracted Electron runtime (worked around extract-zip)');
    } else {
      console.warn('[ensure-electron] re-extract finished but binary still missing:', relPath);
    }
  } catch (e) {
    console.warn('[ensure-electron] skipped:', e && e.message ? e.message : e);
  }
  process.exit(0);
})();
