import { useEffect, useState } from 'react';
import { PixelButton } from './PixelButton';
import { useStore, respawnAgent, type Agent } from '@/store/store';

// Derive the prompt-info shape from the preload-exposed API (window.cth is
// globally typed) — the renderer never reaches across the project boundary.
type AgentPromptInfo = Awaited<ReturnType<Window['cth']['getAgentPrompt']>>;

export interface PromptTabProps {
  agent: Agent;
}

/** Per-agent prompt editor. Shows the FULL composed system prompt (read-only)
 *  plus the operator-editable addendum. Saving persists the addendum to the
 *  registry; it only takes effect when the agent next (re)spawns, so we surface a
 *  "respawn to apply" note and a one-click respawn that reuses the shared flow.
 *  Teammate (read-only) agents — viewedOwner set — disable all controls. */
export function PromptTab({ agent }: PromptTabProps) {
  const readOnly = useStore((s) => s.viewedOwner !== null);
  const [info, setInfo] = useState<AgentPromptInfo | null>(null);
  const [custom, setCustom] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [respawning, setRespawning] = useState(false);
  const [respawnNote, setRespawnNote] = useState<string | null>(null);
  // True once the operator edits/saves after load — drives the "respawn to apply".
  const [dirtySinceSpawn, setDirtySinceSpawn] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    window.cth
      .getAgentPrompt(agent.id)
      .then((res) => {
        if (!alive) return;
        setInfo(res);
        setCustom(res.custom ?? '');
        setDirtySinceSpawn(false);
        setSaveState('idle');
      })
      .catch((e) => {
        if (!alive) return;
        setLoadError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [agent.id]);

  const save = async () => {
    setSaveState('saving');
    setSaveError(null);
    try {
      const res = await window.cth.setAgentPrompt(agent.id, custom);
      if (res.ok) {
        setSaveState('saved');
        setDirtySinceSpawn(true);
        setInfo((prev) => (prev ? { ...prev, custom } : prev));
      } else {
        setSaveState('error');
        setSaveError(res.error ?? 'save failed');
      }
    } catch (e) {
      setSaveState('error');
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  const respawn = async () => {
    if (!confirm(`Respawn ${agent.name}? Its terminal restarts so the saved prompt takes effect.`)) return;
    setRespawning(true);
    setRespawnNote(null);
    const res = await respawnAgent(agent);
    setRespawning(false);
    if (res.ok) {
      setRespawnNote('Respawned — the saved prompt is now applied.');
      setDirtySinceSpawn(false);
    } else {
      setRespawnNote(`Respawn failed: ${res.error ?? 'unknown error'}`);
    }
  };

  const dirty = info ? custom !== info.custom : false;
  const canRespawn = !readOnly && !!agent.ptyId && !respawning;

  if (loading) {
    return <Centered>Loading prompt…</Centered>;
  }
  if (loadError) {
    return <Centered tone="error">Could not load prompt: {loadError}</Centered>;
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 12,
        overflowY: 'auto',
        background: 'var(--cth-paper-200)'
      }}
    >
      {readOnly && (
        <Banner>This is a teammate's agent — read-only. Prompts can only be edited on your own hive.</Banner>
      )}

      {/* Composed system prompt (read-only) */}
      <FieldLabel>Composed system prompt (read-only)</FieldLabel>
      <pre
        style={{
          margin: 0,
          flexShrink: 0,
          maxHeight: '40vh',
          overflow: 'auto',
          padding: 10,
          background: 'var(--cth-paper-100)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
          fontFamily: 'var(--cth-font-mono)',
          fontSize: 12,
          lineHeight: '17px',
          color: 'var(--cth-ink-700)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        }}
      >
        {info?.base?.trim() ? info.base : '(no composed prompt available)'}
      </pre>

      {/* Operator instructions (editable) */}
      <FieldLabel>Operator instructions (editable)</FieldLabel>
      <textarea
        value={custom}
        onChange={(e) => {
          setCustom(e.target.value);
          if (saveState !== 'idle') setSaveState('idle');
        }}
        disabled={readOnly}
        placeholder="Extra instructions appended to this agent's system prompt on its next spawn…"
        rows={6}
        style={{
          width: '100%',
          flexShrink: 0,
          resize: 'vertical',
          padding: 10,
          background: readOnly ? 'var(--cth-cream-200)' : 'var(--cth-paper-100)',
          border: 'none',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
          fontFamily: 'var(--cth-font-mono)',
          fontSize: 13,
          lineHeight: '18px',
          color: 'var(--cth-ink-900)',
          outline: 'none'
        }}
      />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <PixelButton variant="primary" size="sm" onClick={save} disabled={readOnly || saveState === 'saving' || !dirty}>
          {saveState === 'saving' ? 'saving…' : 'save'}
        </PixelButton>
        <PixelButton variant="secondary" size="sm" onClick={respawn} disabled={!canRespawn}>
          {respawning ? 'respawning…' : 'respawn agent'}
        </PixelButton>
        {!readOnly && (saveState === 'saved' || dirtySinceSpawn) && !dirty && (
          <span style={{ fontSize: 13, color: 'var(--cth-ink-700)' }}>
            Saved — respawn this agent to apply.
          </span>
        )}
        {saveState === 'error' && (
          <span style={{ fontSize: 13, color: 'var(--cth-coral)' }}>{saveError}</span>
        )}
        {respawnNote && (
          <span
            style={{
              fontSize: 13,
              color: respawnNote.startsWith('Respawn failed') ? 'var(--cth-coral)' : 'var(--cth-ink-700)'
            }}
          >
            {respawnNote}
          </span>
        )}
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--cth-font-display)',
        fontSize: 9,
        lineHeight: '12px',
        color: 'var(--cth-ink-700)',
        textTransform: 'uppercase',
        flexShrink: 0
      }}
    >
      {children}
    </span>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '6px 10px',
        background: 'var(--cth-lemon-light)',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
        fontSize: 13,
        color: 'var(--cth-ink-900)',
        flexShrink: 0
      }}
    >
      {children}
    </div>
  );
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        background: 'var(--cth-paper-200)',
        fontSize: 14,
        textAlign: 'center',
        color: tone === 'error' ? 'var(--cth-coral)' : 'var(--cth-ink-700)'
      }}
    >
      {children}
    </div>
  );
}
