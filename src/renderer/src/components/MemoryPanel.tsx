import { useEffect, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';

interface MemoryStatus {
  available: boolean;
  enabled: boolean;
  storeReady: boolean;
  active: boolean;
  host: string;
  model: string;
}

/**
 * The human-facing window into the hive's shared semantic memory. Agents write
 * durable facts to their memory.md; the harness embeds those LOCALLY via Ollama
 * and stores the vectors in the team's shared Supabase index, so this searches
 * the whole team's knowledge across sessions and projects. Lets the human search
 * it and toggle the feature on/off.
 */
export function MemoryPanel() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const refreshStatus = async () => {
    try { setStatus(await window.cth.memoryStatus()); } catch { /* ignore */ }
  };
  useEffect(() => { refreshStatus(); }, []);

  const toggleEnabled = async () => {
    await window.cth.updateConfig({ semanticMemory: !(status?.enabled ?? true) });
    await refreshStatus();
  };

  const run = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setResult('');
    try {
      const res = await window.cth.searchMemory(query.trim());
      setResult(res.ok ? (res.output || 'Nothing matched yet.') : `Couldn't search: ${res.error}`);
    } finally {
      setBusy(false);
    }
  };

  const active = status?.active;
  const pill = '🧠 memory';

  // One clear state line, in priority order: off → Ollama down → needs sync → ready.
  const state: { dot: string; label: string } = !status?.enabled
    ? { dot: 'var(--cth-ink-500)', label: 'Off' }
    : !status.available
      ? { dot: 'var(--cth-coral)', label: 'Ollama not reachable' }
      : !status.storeReady
        ? { dot: 'var(--cth-lemon)', label: 'On · needs team sync' }
        : { dot: 'var(--cth-mint)', label: 'On · ready' };

  const canSearch = !!status?.active;

  return (
    <div style={{ position: 'absolute', bottom: 12, left: 12, width: open ? 380 : 'auto', zIndex: 40 }}>
      {!open ? (
        <button
          onClick={() => { setOpen(true); refreshStatus(); }}
          title="Search the shared memory your agents build up"
          style={{
            padding: '5px 10px 3px',
            background: active ? 'var(--cth-lemon-light)' : 'var(--cth-cream-200)',
            boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)',
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 13,
            color: 'var(--cth-ink-900)',
            cursor: 'pointer',
            border: 'none'
          }}
        >
          {pill}
        </button>
      ) : (
        <PixelPanel variant="dialog" title="HIVE MEMORY" noPadding>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 14 }}>

            {/* What this is — one plain line. */}
            <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: 1.5 }}>
              The team's living memory: durable facts your agents record are embedded locally (via Ollama) and shared across every teammate, session, and project. Search it by meaning, not exact words.
            </div>

            {/* Status + on/off — the two things the user controls at a glance. */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-ui)' }}>
                <span style={{ width: 9, height: 9, background: state.dot, boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)' }} />
                {state.label}
              </span>
              {status && (
                <PixelButton
                  variant={status.enabled ? 'secondary' : 'primary'}
                  size="sm"
                  onClick={toggleEnabled}
                >
                  {status.enabled ? 'Turn off' : 'Turn on'}
                </PixelButton>
              )}
            </div>

            {/* Ollama unreachable: show self-sufficient local setup (HuggingFace is
                blocked by the network policy, so embeddings run via local Ollama). */}
            {status?.enabled && !status.available && (
              <div style={{
                fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: 1.6,
                background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', padding: 10
              }}>
                Embeddings run on local Ollama (no data leaves your machine). Start it and pull the model:
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {[
                    'brew install ollama   # or download from ollama.com',
                    'ollama serve          # start the local server',
                    `ollama pull ${status.model}`,
                  ].map((cmd) => (
                    <code key={cmd} style={{
                      display: 'block',
                      fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-900)',
                      background: 'var(--cth-paper-100)', padding: '3px 6px',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                    }}>{cmd}</code>
                  ))}
                </div>
                <div style={{ marginTop: 8, color: 'var(--cth-ink-500)' }}>
                  Looking for Ollama at {status.host}. Agents still keep plain notes without this.
                </div>
              </div>
            )}

            {/* Ollama is up but the shared store needs team sync + sign-in. */}
            {status?.enabled && status.available && !status.storeReady && (
              <div style={{
                fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: 1.6,
                background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', padding: 10
              }}>
                Ollama is ready. The shared memory lives in your team's Supabase — turn on team sync and sign in (Settings) to embed and search it.
              </div>
            )}

            {/* Search the memory. */}
            {canSearch && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
                    placeholder="Search by meaning…"
                    style={{
                      flex: 1, padding: '6px 8px 4px',
                      background: 'var(--cth-paper-100)', border: 'none',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
                      fontFamily: 'var(--cth-font-ui)', fontSize: 14,
                      color: 'var(--cth-ink-900)', outline: 'none'
                    }}
                  />
                  <PixelButton variant="primary" size="sm" onClick={run} disabled={busy}>
                    {busy ? '…' : 'Search'}
                  </PixelButton>
                </div>
                {result && (
                  <pre style={{
                    margin: 0, maxHeight: '40vh', overflow: 'auto',
                    background: 'var(--cth-cream-100)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
                    padding: 8, fontFamily: 'var(--cth-font-mono)', fontSize: 12,
                    whiteSpace: 'pre-wrap', color: 'var(--cth-ink-900)'
                  }}>{result}</pre>
                )}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid var(--cth-ink-300)', paddingTop: 10 }}>
              <PixelButton variant="ghost" size="sm" onClick={() => setOpen(false)}>Close</PixelButton>
            </div>
          </div>
        </PixelPanel>
      )}
    </div>
  );
}
