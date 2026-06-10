/**
 * AGENT LIBRARY — the shared catalog of published agent definitions. Polls
 * window.cth.listSharedAgents() and renders each as a pixel card: identity
 * (Avatar accent + name + model), role, capability chips, the "why unique"
 * note, and the author. "Add to my hive" feeds the row into the store's
 * setAddAgentPrefill({...}), which opens the pre-filled Add-Agent modal; a
 * subtle "remove" calls window.cth.unpublishAgent(id).
 */
import { useEffect, useState } from 'react';
import { useStore } from '@/store/store';
import { Avatar } from '@/components/Avatar';
import { PixelButton } from '@/components/PixelButton';
import { type AccentColorName } from '@/design/tokens';

// Derive the catalog row shape from the preload-exposed API (window.cth is
// globally typed) — the renderer never reaches across the project boundary.
type SharedAgent = Awaited<ReturnType<Window['cth']['listSharedAgents']>>[number];

const ACCENTS: readonly AccentColorName[] = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'];

/** Coerce a free-form accent string from the catalog into a known accent name,
 *  falling back to a stable default so the Avatar always renders. */
function asAccent(accent: string | null): AccentColorName {
  return (ACCENTS as readonly string[]).includes(accent ?? '') ? (accent as AccentColorName) : 'sky';
}

export function AgentLibrary() {
  const [agents, setAgents] = useState<SharedAgent[]>([]);
  // Assume synced until the first status check so we don't flash the
  // "turn on sync" hint before we actually know.
  const [synced, setSynced] = useState(true);
  const setAddAgentPrefill = useStore((s) => s.setAddAgentPrefill);
  // Bumped by a successful Publish so we reload at once (not on the 15s poll).
  const nonce = useStore((s) => s.sharedAgentsNonce);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const rows = await window.cth.listSharedAgents();
        if (alive) setAgents(rows);
      } catch {
        /* best-effort — leave the current list */
      }
      try {
        const st = await window.cth.syncStatus();
        if (alive) setSynced(!!st?.configured && !!st?.auth?.signedIn);
      } catch {
        /* ignore — keep prior */
      }
    };
    void load();
    const t = window.setInterval(load, 15000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [nonce]);

  const addToHive = (a: SharedAgent): void => {
    setAddAgentPrefill({
      name: a.name,
      role: a.role ?? undefined,
      model: a.model ?? undefined,
      accent: a.accent ?? undefined,
      capabilities: a.capabilities,
      customPrompt: a.customPrompt ?? undefined
    });
  };

  const remove = async (id: string): Promise<void> => {
    // Optimistic drop; refresh covers the next poll if it failed.
    setAgents((prev) => prev.filter((a) => a.id !== id));
    try {
      await window.cth.unpublishAgent(id);
    } catch {
      /* best-effort */
    }
  };

  return (
    <Section title="AGENT LIBRARY">
      {agents.length === 0 ? (
        <Placeholder>
          {synced
            ? 'No shared agents yet — Publish one from an agent card.'
            : 'Turn on team sync and sign in (Settings → Sync) to publish and see shared agents.'}
        </Placeholder>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {agents.map((a) => (
            <AgentRow key={a.id} agent={a} onAdd={() => addToHive(a)} onRemove={() => remove(a.id)} />
          ))}
        </div>
      )}
    </Section>
  );
}

function AgentRow({
  agent,
  onAdd,
  onRemove
}: {
  agent: SharedAgent;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const accent = asAccent(agent.accent);
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        padding: 8,
        background: 'var(--cth-cream-100)',
        boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)'
      }}
    >
      <Avatar name={agent.name} accent={accent} size={32} style={{ marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* identity line: name · model dot */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span
            style={{
              fontFamily: 'var(--cth-font-display)',
              fontSize: 11,
              lineHeight: '14px',
              color: 'var(--cth-ink-900)'
            }}
          >
            {agent.name}
          </span>
          {agent.model && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: `var(--cth-${accent})`,
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)'
                }}
              />
              <span style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>{agent.model}</span>
            </span>
          )}
        </div>

        {agent.role && (
          <div style={{ fontSize: 11, color: 'var(--cth-ink-700)', marginTop: 2 }}>{agent.role}</div>
        )}

        {agent.capabilities.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
            {agent.capabilities.map((cap) => (
              <span
                key={cap}
                style={{
                  fontSize: 9,
                  lineHeight: '14px',
                  padding: '0 5px',
                  color: 'var(--cth-ink-700)',
                  background: 'var(--cth-cream-200)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-500)'
                }}
              >
                {cap}
              </span>
            ))}
          </div>
        )}

        {agent.why && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--cth-ink-700)',
              marginTop: 4,
              fontStyle: 'italic'
            }}
          >
            “{agent.why}”
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <PixelButton size="sm" variant="secondary" onClick={onAdd}>
            Add to my hive
          </PixelButton>
          <button
            onClick={onRemove}
            title="Remove from the shared catalog"
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--cth-ink-500)',
              fontFamily: 'var(--cth-font-ui)',
              fontSize: 10,
              cursor: 'pointer',
              padding: 0
            }}
          >
            remove
          </button>
          {agent.authorLabel && (
            <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--cth-ink-500)' }}>
              by {agent.authorLabel}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '12px', color: 'var(--cth-ink-500)', marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{children}</div>;
}
