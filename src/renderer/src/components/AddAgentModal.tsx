import { useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { useStore, type Agent } from '@/store/store';
import { type AccentColorName } from '@/design/tokens';
import {
  type AgentProvider,
  type HarnessConfig,
  AGENT_PROVIDER_PRESETS,
  buildSpawnCommand,
  tokenizeCommand,
  modelsForProvider,
  inferAgentProvider,
  providerPreset,
  isClaudeProvider
} from '@/store/config';
import { spawnPtyForTeam, workerPtyId } from '@/ipc/teams';

const ACCENTS: AccentColorName[] = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'];

/** Pre-made agent formats. Each spawns with a STABLE id so it adopts the charter
 *  pre-seeded in `hive/agents/<id>/memory.md` (the harness seeds memory.md once
 *  and never overwrites it). All are Claude agents; effort is set per-charter. */
interface AgentPreset {
  id: string;
  name: string;
  role: string;
  model: string;
  accent: AccentColorName;
  capabilities: string[];
}
export const AGENT_PRESETS: AgentPreset[] = [
  { id: 'architect',       name: 'Architect',       role: 'technical lead & planner',      model: 'claude-opus-4-8',   accent: 'lilac', capabilities: ['planning', 'system-design', 'decomposition', 'spec-writing'] },
  { id: 'backend',         name: 'Backend',         role: 'backend & API engineer',        model: 'claude-sonnet-4-6', accent: 'sky',   capabilities: ['apis', 'services', 'databases', 'business-logic', 'unit-tests'] },
  { id: 'frontend',        name: 'Frontend',        role: 'frontend & UI engineer',        model: 'claude-sonnet-4-6', accent: 'mint',  capabilities: ['ui', 'components', 'state', 'styling', 'accessibility', 'frontend-tests'] },
  { id: 'data-ml',         name: 'Data/ML',         role: 'data pipelines & ML engineer',  model: 'claude-opus-4-8',   accent: 'peach', capabilities: ['data-pipelines', 'analysis', 'ml', 'notebooks', 'sql', 'evaluation'] },
  { id: 'infra-devops',    name: 'Infra',           role: 'DevOps & automation engineer',  model: 'claude-opus-4-8',   accent: 'lemon', capabilities: ['ci-cd', 'github-actions', 'gh-aw', 'cloud', 'scripting', 'release'] },
  { id: 'rp-integrations', name: 'RP-Integrations', role: 'RealPage systems integrator',   model: 'claude-opus-4-8',   accent: 'coral', capabilities: ['tfs', 'salesforce-sr', 'azure-ad', 'sharepoint', 'basic-memory'] },
  { id: 'reviewer',        name: 'Reviewer',        role: 'code reviewer & security auditor', model: 'claude-opus-4-8', accent: 'lilac', capabilities: ['code-review', 'security-review', 'correctness', 'standards'] },
  { id: 'qa-verify',       name: 'QA',              role: 'QA & verification engineer',    model: 'claude-sonnet-4-6', accent: 'mint',  capabilities: ['testing', 'run-app', 'verify', 'regression', 'repro'] },
  { id: 'researcher',      name: 'Researcher',      role: 'research & documentation',      model: 'claude-opus-4-8',   accent: 'sky',   capabilities: ['deep-research', 'web-search', 'synthesis', 'docs', 'fact-check'] }
];

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function uniqueId(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`;
}

export interface AddAgentModalProps {
  onClose: () => void;
  config: HarnessConfig;
}

export function AddAgentModal({ onClose, config }: AddAgentModalProps) {
  const addAgent = useStore(s => s.addAgent);
  // A non-null prefill (from the Agent Library's "Add to my hive") seeds the form.
  // Captured once on mount; cleared when the modal closes.
  const prefill = useStore(s => s.addAgentPrefill);
  const setAddAgentPrefill = useStore(s => s.setAddAgentPrefill);

  // Default provider follows whatever the global default command is (claude
  // unless the user reconfigured it); the model only carries over for Claude.
  // A prefill always targets a Claude agent (the published catalog is Claude-only).
  const initialProvider: AgentProvider = prefill ? 'claude' : inferAgentProvider(config.defaultCommand);
  const initialModel = prefill
    ? (prefill.model ?? config.defaultModel)
    : (isClaudeProvider(initialProvider) ? config.defaultModel : undefined);
  // The accent from a SharedAgent is a loose string; only adopt it when it's a
  // real accent name, otherwise fall back to the default.
  const prefillAccent: AccentColorName =
    prefill && ACCENTS.includes(prefill.accent as AccentColorName)
      ? (prefill.accent as AccentColorName)
      : 'sky';

  const [name, setName] = useState(prefill?.name ?? 'Worker');
  const [accent, setAccent] = useState<AccentColorName>(prefillAccent);
  const [cwd, setCwd] = useState<string>(config.registeredRepos[0] ?? '');
  const [provider, setProvider] = useState<AgentProvider>(initialProvider);
  const [model, setModel] = useState<string | undefined>(initialModel);
  const [command, setCommand] = useState(buildSpawnCommand(config, initialModel, initialProvider));
  const [description, setDescription] = useState(prefill?.role ?? 'a fresh harness');
  // Capabilities carried from the published agent → flow into the hive meta on
  // spawn (and ride along on respawns via the registry).
  const [prefillCapabilities] = useState<string[] | undefined>(prefill?.capabilities);
  // The published operator-prompt addendum — applied AFTER spawn (setAgentPrompt).
  const [prefillCustomPrompt] = useState<string | undefined>(prefill?.customPrompt);

  // Picking a model rebuilds the command; the command field stays editable for
  // power users (it's the source of truth for the actual spawn).
  const pickModel = (id?: string) => {
    setModel(id);
    setCommand(buildSpawnCommand(config, id, provider));
  };
  // Switching provider resets the model to that CLI's default and rebuilds the
  // command from the provider's preset binary (so Antigravity spawns `agy` and
  // Codex spawns `codex`, not the configured `claude`). For 'custom' we keep the
  // user's typed command rather than blanking it.
  const pickProvider = (id: AgentProvider) => {
    setProvider(id);
    const nextModel = isClaudeProvider(id) ? config.defaultModel : undefined;
    setModel(nextModel);
    if (id === 'custom') {
      setCommand(command.trim() || config.defaultCommand || '');
      return;
    }
    setCommand(buildSpawnCommand(config, nextModel, id));
  };
  const preset = providerPreset(provider);
  const [goal, setGoal] = useState('');
  const [isolate, setIsolate] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // null = "Custom" (the original freeform flow). Selecting a preset fills the
  // form AND pins the spawn id to the preset's stable id so it adopts the
  // charter pre-seeded in hive/agents/<id>/memory.md.
  const [presetId, setPresetId] = useState<string | null>(null);
  const selectedPreset = AGENT_PRESETS.find(p => p.id === presetId);
  const applyPreset = (p: AgentPreset) => {
    setPresetId(p.id);
    setName(p.name);
    setDescription(p.role);
    setAccent(p.accent);
    setProvider('claude');
    setModel(p.model);
    setCommand(buildSpawnCommand(config, p.model, 'claude'));
    setError(undefined);
  };

  const pickFolder = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) setCwd(res.path);
    else if (res.error !== 'cancelled') setError(res.error);
  };

  // Closing the modal always clears any pending prefill so a later manual open
  // starts clean.
  const closeModal = () => {
    setAddAgentPrefill(null);
    onClose();
  };

  const submit = async () => {
    setError(undefined);
    if (!name.trim()) { setError('Name is required'); return; }
    if (!cwd) { setError('Pick a folder first'); return; }
    if (!command.trim()) { setError('Command is required'); return; }

    setBusy(true);
    // A preset pins the id (so it maps to its pre-seeded charter); custom agents
    // get a fresh unique id as before.
    const id = selectedPreset?.id ?? uniqueId(name);
    // FE-7 + MT-CLONE-3: scope the PTY id to the team this agent joins so adding a
    // worker to a non-default/cloned team can't collide with another team's PTY in
    // the main process's global session map. Capture the team once so the ptyId and
    // the spawn below target the SAME team even if the active team changes mid-submit.
    const teamId = useStore.getState().activeTeamId;
    const ptyId = workerPtyId(teamId, id);
    // Split the editable command field into argv-style pieces for node-pty.
    // Quote-aware so an agy model label like "Gemini 3.1 Pro (High)" — or any
    // auto-mode flags appended to the command — stays one argument.
    const [exe, ...args] = tokenizeCommand(command.trim());
    // FE-7: a newly added agent joins the team that's in view.
    const spawnRes = await spawnPtyForTeam({
      id: ptyId,
      cwd,
      command: exe,
      provider,
      args,
      cols: 100,
      rows: 30,
      // When set, the main process spawns this agent in its own git worktree.
      isolate,
      // Provision this agent in the hive (memory + mailbox + identity/protocol).
      hive: {
        id,
        name: name.trim(),
        provider,
        cwd,
        role: description.trim() || undefined,
        capabilities: selectedPreset?.capabilities ?? prefillCapabilities
      }
    }, teamId);
    if (!spawnRes.ok) {
      setBusy(false);
      setError(spawnRes.error ?? 'spawn failed');
      return;
    }

    // A published agent carries an operator-prompt addendum — persist it onto the
    // freshly-spawned agent so its next respawn applies it (mirrors the PROMPT tab).
    if (prefillCustomPrompt) {
      await window.cth.setAgentPrompt(id, prefillCustomPrompt).catch(() => { /* best-effort */ });
    }

    const agent: Agent = {
      id,
      name: name.trim(),
      accent,
      description: description.trim() || 'a fresh harness',
      project: basename(cwd),
      tmuxTarget: '',
      cwd,
      goal: goal.trim() || undefined,
      status: 'idle',
      action: 'starting up',
      progress: 0,
      currentStation: 'desk',
      ptyId,
      command: command.trim(),
      provider,
      model,
      recentTextTs: Date.now()
    };
    addAgent(agent);
    setBusy(false);
    closeModal();
  };

  return (
    <div
      onClick={closeModal}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(26, 19, 32, 0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 600, maxWidth: '92vw' }}>
        <PixelPanel
          variant="dialog"
          title="ADD AGENT"
          style={{ padding: 16 }}
          noPadding
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
            <Row label="Template">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  onClick={() => setPresetId(null)}
                  title="Configure every field by hand"
                  style={{
                    padding: '3px 8px 1px',
                    background: presetId === null ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                    boxShadow: presetId === null
                      ? 'inset 0 0 0 2px var(--cth-ink-900)'
                      : 'inset 0 0 0 1px var(--cth-ink-700)',
                    fontFamily: 'var(--cth-font-ui)', fontSize: 13,
                    color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
                  }}
                >
                  Custom
                </button>
                {AGENT_PRESETS.map((p) => {
                  const active = presetId === p.id;
                  return (
                    <button
                      key={p.id}
                      onClick={() => applyPreset(p)}
                      title={`${p.role} · ${p.model.includes('opus') ? 'Opus' : p.model.includes('sonnet') ? 'Sonnet' : p.model}`}
                      style={{
                        padding: '3px 8px 1px',
                        background: active ? `var(--cth-${p.accent}-light)` : 'var(--cth-cream-100)',
                        boxShadow: active
                          ? 'inset 0 0 0 2px var(--cth-ink-900)'
                          : 'inset 0 0 0 1px var(--cth-ink-700)',
                        fontFamily: 'var(--cth-font-ui)', fontSize: 13,
                        color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
                      }}
                    >
                      {p.name}
                    </button>
                  );
                })}
              </div>
            </Row>

            <Row label="Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ada"
                style={inputStyle}
              />
            </Row>

            <Row label="Folder">
              {config.registeredRepos.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                  {config.registeredRepos.map((r) => (
                    <button
                      key={r}
                      onClick={() => setCwd(r)}
                      title={r}
                      style={{
                        padding: '3px 8px 1px',
                        background: cwd === r ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                        boxShadow: cwd === r
                          ? 'inset 0 0 0 2px var(--cth-ink-900)'
                          : 'inset 0 0 0 1px var(--cth-ink-700)',
                        fontFamily: 'var(--cth-font-ui)',
                        fontSize: 13,
                        cursor: 'pointer',
                        border: 'none'
                      }}
                    >
                      {basename(r)}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder="/path/to/your/project"
                  style={{ ...inputStyle, flex: 1, fontFamily: 'var(--cth-font-mono)', fontSize: 14 }}
                />
                <PixelButton variant="secondary" size="md" onClick={pickFolder}>
                  <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                    <Icon name="folder" /> pick
                  </span>
                </PixelButton>
              </div>
            </Row>

            <Row label="Provider">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {AGENT_PROVIDER_PRESETS.map((p) => {
                  const active = provider === p.id;
                  return (
                    <button
                      key={p.id}
                      onClick={() => pickProvider(p.id)}
                      title={
                        p.id === 'antigravity'
                          ? 'Spawn the Antigravity CLI (agy) with a Gemini model'
                          : p.id === 'codex'
                            ? 'Spawn the Codex CLI (codex) without Claude-only flags'
                            : p.id === 'custom'
                              ? 'Run any command — no Claude-only flags'
                              : p.label
                      }
                      style={{
                        padding: '3px 8px 1px',
                        background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                        boxShadow: active
                          ? 'inset 0 0 0 2px var(--cth-ink-900)'
                          : 'inset 0 0 0 1px var(--cth-ink-700)',
                        fontFamily: 'var(--cth-font-ui)', fontSize: 13,
                        color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
                      }}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </Row>

            {preset.supportsModel && <Row label="Model">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {modelsForProvider(provider).map((m) => {
                  const active = (model ?? '') === (m.id ?? '');
                  return (
                    <button
                      key={m.label}
                      onClick={() => pickModel(m.id)}
                      title={m.id ?? 'CLI default model'}
                      style={{
                        padding: '3px 8px 1px',
                        background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                        boxShadow: active
                          ? 'inset 0 0 0 2px var(--cth-ink-900)'
                          : 'inset 0 0 0 1px var(--cth-ink-700)',
                        fontFamily: 'var(--cth-font-ui)', fontSize: 13,
                        color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
                      }}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </Row>}

            <Row label={config.autoMode && preset.autoFlag ? 'Command (auto mode on)' : 'Command'}>
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={
                  provider === 'antigravity'
                    ? 'agy'
                    : provider === 'codex'
                      ? 'codex'
                      : provider === 'custom'
                        ? 'your-agent-cli'
                        : 'claude'
                }
                style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }}
              />
            </Row>

            <Row label="Description">
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="what is this agent for"
                style={inputStyle}
              />
            </Row>

            <Row label="Goal (optional)">
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="long-running directive injected on every prompt"
                rows={2}
                style={{ ...inputStyle, fontFamily: 'var(--cth-font-ui)', resize: 'none' }}
              />
            </Row>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={isolate}
                onChange={(e) => setIsolate(e.target.checked)}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
              <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 14, color: 'var(--cth-ink-900)' }}>
                Git isolation (own worktree)
              </span>
            </label>

            <Row label="Color">
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <Avatar name={name || 'Worker'} accent={accent} size={40} />
                <div style={{ display: 'flex', gap: 6 }}>
                  {ACCENTS.map(a => (
                    <button
                      key={a}
                      onClick={() => setAccent(a)}
                      style={{
                        width: 32, height: 32,
                        background: `var(--cth-${a})`,
                        boxShadow: accent === a
                          ? 'inset 0 0 0 2px var(--cth-ink-900), 0 0 0 2px var(--cth-ink-900)'
                          : 'inset 0 0 0 1px var(--cth-ink-900)',
                        cursor: 'pointer',
                        border: 'none'
                      }}
                      aria-label={a}
                    />
                  ))}
                </div>
              </div>
            </Row>

            {error && (
              <div style={{
                padding: '6px 10px',
                background: 'var(--cth-coral-light)',
                boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
                fontSize: 14,
                color: 'var(--cth-ink-900)'
              }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <PixelButton variant="ghost" size="md" onClick={closeModal} disabled={busy}>cancel</PixelButton>
              <PixelButton variant="primary" size="md" onClick={submit} disabled={busy}>
                {busy ? 'spawning...' : 'spawn'}
              </PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 16,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        fontFamily: 'var(--cth-font-display)',
        fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-700)',
        textTransform: 'uppercase'
      }}>{label}</span>
      {children}
    </label>
  );
}
