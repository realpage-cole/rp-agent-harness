import { useEffect, useState } from 'react';
import { PixelButton } from './PixelButton';
import { Avatar } from './Avatar';
import { disposeTerminal } from './terminalPool';
import { useStore, respawnAgent, type Agent } from '@/store/store';
import { type AccentColorName } from '@/design/tokens';
import {
  inferAgentProvider,
  modelsForProvider,
  providerPreset
} from '@/store/config';

const ACCENTS: AccentColorName[] = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'];

export interface ConfigTabProps {
  agent: Agent;
}

/** Per-agent settings form. Name/accent/description are display state (store +
 *  localStorage); name/role/capabilities also persist to the hive registry via
 *  updateAgentMeta. Model + prompt changes APPLY ON RESPAWN — changing the model
 *  confirms then respawns via the shared respawnAgent helper. Teammate agents
 *  (viewedOwner set) are read-only. */
export function ConfigTab({ agent }: ConfigTabProps) {
  const readOnly = useStore((s) => s.viewedOwner !== null);
  const updateAgent = useStore((s) => s.updateAgent);
  const archiveAgent = useStore((s) => s.archiveAgent);

  const [name, setName] = useState(agent.name);
  const [accent, setAccent] = useState<AccentColorName>(agent.accent);
  const [description, setDescription] = useState(agent.description);
  const [capabilities, setCapabilities] = useState('');
  const [tokenCap, setTokenCap] = useState('');
  const [respawning, setRespawning] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Hydrate role/capabilities from the registry and the per-agent token cap from
  // config, on mount / agent-change.
  useEffect(() => {
    let alive = true;
    setName(agent.name);
    setAccent(agent.accent);
    setDescription(agent.description);
    setNote(null);
    window.cth.hiveRegistry().then((reg) => {
      if (!alive) return;
      const meta = reg.agents?.[agent.id];
      if (meta?.capabilities) setCapabilities(meta.capabilities.join(', '));
      else setCapabilities('');
    }).catch(() => { /* noop */ });
    window.cth.getConfig().then((c) => {
      if (!alive) return;
      const cap = c.agentTokenCaps?.[agent.id];
      setTokenCap(cap && cap > 0 ? String(cap) : '');
    }).catch(() => { /* noop */ });
    return () => { alive = false; };
  }, [agent.id, agent.name, agent.accent, agent.description]);

  const provider = inferAgentProvider(agent.command, agent.provider);
  const supportsModel = providerPreset(provider).supportsModel;
  const models = modelsForProvider(provider);

  // Persist name/role/capabilities LIVE: store (display) + registry (meta).
  const persistMeta = (next: { name?: string; role?: string; capabilities?: string[] }) => {
    void window.cth.updateAgentMeta(agent.id, next).catch(() => { /* noop */ });
  };

  const commitName = () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === agent.name) return;
    updateAgent(agent.id, { name: trimmed });
    persistMeta({ name: trimmed });
  };
  const commitDescription = () => {
    const trimmed = description.trim();
    if (trimmed === agent.description) return;
    updateAgent(agent.id, { description: trimmed });
    persistMeta({ role: trimmed });
  };
  const commitCapabilities = () => {
    const list = capabilities.split(',').map((c) => c.trim()).filter(Boolean);
    persistMeta({ capabilities: list });
  };
  const pickAccent = (a: AccentColorName) => {
    setAccent(a);
    updateAgent(agent.id, { accent: a }); // display-only → store/localStorage
  };

  // Per-agent token cap → updateConfig({ agentTokenCaps }). Merge into the full
  // map (the IPC replaces the top-level key).
  const commitTokenCap = async () => {
    const n = parseInt(tokenCap, 10);
    try {
      const c = await window.cth.getConfig();
      const next = { ...(c.agentTokenCaps ?? {}) };
      if (Number.isFinite(n) && n > 0) next[agent.id] = n; else delete next[agent.id];
      await window.cth.updateConfig({ agentTokenCaps: next });
    } catch { /* noop */ }
  };

  const changeModel = async (model: string | undefined) => {
    if ((agent.model ?? '') === (model ?? '')) return;
    if (!confirm('Change model and respawn this agent? Its terminal restarts.')) return;
    setRespawning(true);
    setNote(null);
    const res = await respawnAgent(agent, { model, updateModel: true });
    setRespawning(false);
    setNote(res.ok ? 'Model changed — agent respawned.' : `Respawn failed: ${res.error ?? 'unknown error'}`);
  };

  const onArchive = async () => {
    if (!agent.ptyId) return;
    if (!confirm(`Archive ${agent.name}? The PTY terminates and the agent leaves the roster (kept in history).`)) return;
    await window.cth.killPty(agent.ptyId);
    disposeTerminal(agent.ptyId);
    archiveAgent(agent.id);
  };

  const disabled = readOnly;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 12,
        overflowY: 'auto',
        background: 'var(--cth-paper-200)'
      }}
    >
      {readOnly && (
        <Banner>This is a teammate's agent — read-only. Settings can only be changed on your own hive.</Banner>
      )}

      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          disabled={disabled}
          style={inputStyle(disabled)}
        />
      </Field>

      <Field label="Color">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Avatar name={name || 'Worker'} accent={accent} size={36} />
          <div style={{ display: 'flex', gap: 6 }}>
            {ACCENTS.map((a) => (
              <button
                key={a}
                onClick={() => !disabled && pickAccent(a)}
                disabled={disabled}
                aria-label={a}
                style={{
                  width: 28, height: 28,
                  background: `var(--cth-${a})`,
                  boxShadow: accent === a
                    ? 'inset 0 0 0 2px var(--cth-ink-900), 0 0 0 2px var(--cth-ink-900)'
                    : 'inset 0 0 0 1px var(--cth-ink-900)',
                  cursor: disabled ? 'default' : 'pointer',
                  border: 'none',
                  opacity: disabled ? 0.5 : 1
                }}
              />
            ))}
          </div>
        </div>
      </Field>

      <Field label="Role / description">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={commitDescription}
          disabled={disabled}
          placeholder="what is this agent for"
          style={inputStyle(disabled)}
        />
      </Field>

      <Field label="Capabilities (comma-separated)">
        <input
          value={capabilities}
          onChange={(e) => setCapabilities(e.target.value)}
          onBlur={commitCapabilities}
          disabled={disabled}
          placeholder="apis, services, unit-tests"
          style={inputStyle(disabled)}
        />
      </Field>

      {supportsModel && (
        <Field label="Model (applies on respawn)">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {models.map((m) => {
              const active = (agent.model ?? '') === (m.id ?? '');
              return (
                <button
                  key={m.label}
                  onClick={() => !disabled && !respawning && changeModel(m.id)}
                  disabled={disabled || respawning}
                  title={m.id ?? 'CLI default model'}
                  style={{
                    padding: '3px 8px 1px',
                    background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                    boxShadow: active
                      ? 'inset 0 0 0 2px var(--cth-ink-900)'
                      : 'inset 0 0 0 1px var(--cth-ink-700)',
                    fontFamily: 'var(--cth-font-ui)', fontSize: 13,
                    color: 'var(--cth-ink-900)',
                    cursor: disabled || respawning ? 'default' : 'pointer',
                    border: 'none',
                    opacity: disabled ? 0.6 : 1
                  }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
          {respawning && (
            <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>respawning…</span>
          )}
        </Field>
      )}

      <Field label="Token cap (per agent)">
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            value={tokenCap}
            onChange={(e) => setTokenCap(e.target.value.replace(/[^0-9]/g, ''))}
            onBlur={commitTokenCap}
            disabled={disabled}
            inputMode="numeric"
            placeholder="no cap"
            style={{ ...inputStyle(disabled), maxWidth: 180, fontFamily: 'var(--cth-font-mono)' }}
          />
          <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>tokens · 0 / blank = no cap</span>
        </div>
      </Field>

      <div
        style={{
          fontSize: 12,
          color: 'var(--cth-ink-500)',
          paddingTop: 2
        }}
      >
        Model and prompt changes apply on respawn. Name, color, role, capabilities and the token cap apply live.
      </div>

      {note && (
        <div
          style={{
            fontSize: 13,
            color: note.startsWith('Respawn failed') ? 'var(--cth-coral)' : 'var(--cth-ink-700)'
          }}
        >
          {note}
        </div>
      )}

      {!readOnly && !!agent.ptyId && (
        <div style={{ marginTop: 4 }}>
          <PixelButton variant="destructive" size="sm" onClick={onArchive}>
            archive agent
          </PixelButton>
        </div>
      )}
    </div>
  );
}

function inputStyle(disabled: boolean): React.CSSProperties {
  return {
    width: '100%',
    padding: '6px 8px 4px',
    background: disabled ? 'var(--cth-cream-200)' : 'var(--cth-paper-100)',
    border: 'none',
    boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
    fontFamily: 'var(--cth-font-ui)',
    fontSize: 15,
    color: 'var(--cth-ink-900)',
    outline: 'none'
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span
        style={{
          fontFamily: 'var(--cth-font-display)',
          fontSize: 9,
          lineHeight: '12px',
          color: 'var(--cth-ink-700)',
          textTransform: 'uppercase'
        }}
      >
        {label}
      </span>
      {children}
    </label>
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
        color: 'var(--cth-ink-900)'
      }}
    >
      {children}
    </div>
  );
}
