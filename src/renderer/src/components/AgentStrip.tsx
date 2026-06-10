import { useEffect, useState } from 'react';
import { AgentCard } from './AgentCard';
import { PixelButton } from './PixelButton';
import { PixelPanel } from './PixelPanel';
import { Icon } from './Icon';
import { useStore, type Agent } from '@/store/store';
import { buildSpawnCommand, inferAgentProvider, tokenizeCommand, type HarnessConfig } from '@/store/config';

export interface AgentStripProps {
  /** Needed to rebuild a spawn command when a restorable agent predates the
   *  persisted `command` field. Optional so the strip renders without config. */
  config?: HarnessConfig | null;
}

export function AgentStrip({ config }: AgentStripProps) {
  const agents = useStore(s => s.agents);
  const restorableAgents = useStore(s => s.restorableAgents);
  const selectedId = useStore(s => s.selectedId);
  const select = useStore(s => s.select);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const openTaskDetail = useStore(s => s.openTaskDetail);
  const bumpSharedAgents = useStore(s => s.bumpSharedAgents);
  const [restoring, setRestoring] = useState(false);
  // Transient per-agent publish feedback for the card button ('busy' → 'ok').
  const [pubState, setPubState] = useState<Record<string, 'busy' | 'ok'>>({});
  // The agent being published, if any (drives the in-app publish dialog —
  // Electron renderers don't support window.prompt, so we collect "why" here).
  const [publishTarget, setPublishTarget] = useState<Agent | null>(null);
  const [publishWhy, setPublishWhy] = useState('');
  // Each worker's actively-DOING ledger tasks, polled from hive/tasks.json —
  // rendered as a sticky note on the avatar card (click → task detail).
  const [doingByAgent, setDoingByAgent] = useState<Record<string, string[]>>({});
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const raw = await window.cth.hiveTasks() as { tasks?: Array<{ id?: string; status?: string; assignee?: string }> } | null;
        if (cancelled) return;
        const map: Record<string, string[]> = {};
        for (const t of (raw && Array.isArray(raw.tasks)) ? raw.tasks : []) {
          if (t?.status === 'doing' && typeof t.assignee === 'string' && t.assignee && typeof t.id === 'string') {
            (map[t.assignee] = map[t.assignee] ?? []).push(t.id);
          }
        }
        setDoingByAgent(map);
      } catch { /* keep last good */ }
    };
    void poll();
    const iv = setInterval(() => { void poll(); }, 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  /** Open the in-app publish dialog for a LOCAL agent (window.prompt is a no-op
   *  in Electron, so we collect the "why" with a real dialog). */
  const openPublish = (agent: Agent): void => {
    setPublishWhy('');
    setPublishTarget(agent);
  };

  /** Confirm publish from the dialog: gather the agent's identity + operator
   *  prompt addendum and call window.cth.publishAgent with the typed "why". */
  const confirmPublish = async () => {
    const agent = publishTarget;
    if (!agent) return;
    const why = publishWhy.trim();
    setPublishTarget(null);
    let customPrompt = '';
    try {
      const info = await window.cth.getAgentPrompt(agent.id);
      customPrompt = info?.custom ?? '';
    } catch { /* best-effort — publish without the addendum */ }
    const meta = (await window.cth.hiveRegistry().catch(() => null))?.agents?.[agent.id];
    setPubState((s) => ({ ...s, [agent.id]: 'busy' }));
    let res: { ok: boolean; error?: string };
    try {
      res = await window.cth.publishAgent({
        name: agent.name,
        role: agent.description || undefined,
        model: agent.model,
        accent: agent.accent,
        capabilities: meta?.capabilities,
        customPrompt: customPrompt || undefined
      }, why);
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (res.ok) {
      // Green "Published ✓" for ~1.8s, and refresh the library now (don't wait
      // for its ~15s poll).
      setPubState((s) => ({ ...s, [agent.id]: 'ok' }));
      bumpSharedAgents();
      setTimeout(() => setPubState((s) => { const n = { ...s }; delete n[agent.id]; return n; }), 1800);
    } else {
      setPubState((s) => { const n = { ...s }; delete n[agent.id]; return n; });
      // The publish + library are Supabase-synced — make the sign-in case clear.
      const err = res.error ?? 'unknown error';
      const msg = /sign in|workspace/i.test(err)
        ? 'Turn on team sync and sign in (Settings → Sync), and set a workspace, to publish to the shared library.'
        : `Publish failed: ${err}`;
      window.alert(msg);
    }
  };

  /** Respawn every worker from the previous session with its ORIGINAL agent id,
   *  cwd, model and command — the hive workspace (memory.md, inbox, registry
   *  entry) reattaches by itself, no memory transplant needed. */
  const restoreTeam = async () => {
    if (restoring) return;
    setRestoring(true);
    const prevSel = useStore.getState().selectedId;
    try {
      for (const a of [...restorableAgents]) {
        const provider = inferAgentProvider(a.command, a.provider);
        const command = (a.command ?? '').trim() || (config ? buildSpawnCommand(config, a.model, provider) : '');
        if (!command || !a.cwd) { useStore.getState().removeRestorableAgent(a.id); continue; }
        const [exe, ...args] = tokenizeCommand(command);
        const ptyId = a.ptyId ?? `pty-${a.id}`;
        const res = await window.cth.spawnPty({
          id: ptyId,
          cwd: a.cwd,
          command: exe,
          provider,
          args,
          cols: 100,
          rows: 30,
          // Continue the worker's prior CLI session if one was recorded — the
          // main process picks the provider's resume flag (Claude --resume,
          // agy --conversation). No-op when there's no recorded session id.
          resume: true,
          // Re-request isolation if the agent ran in its own worktree before —
          // the old worktree was torn down on exit, so a fresh one is created.
          isolate: !!a.worktreePath,
          hive: { id: a.id, name: a.name, provider, cwd: a.cwd, role: a.description }
        });
        if (res.ok) {
          useStore.getState().addAgent({
            ...a,
            provider,
            ptyId,
            archived: false,
            status: 'idle',
            action: 'starting up',
            carrying: undefined,
            currentStation: 'desk',
            recentTextTs: Date.now()
          });
        } else {
          // Leave it restorable so the user can retry; don't block the rest.
          console.error('[restore] spawn failed for', a.id, res.error);
        }
      }
    } finally {
      // addAgent auto-selects each spawn; put the user back where they were.
      const sel = useStore.getState();
      if (prevSel && sel.agents.some((x) => x.id === prevSel)) sel.select(prevSel);
      setRestoring(false);
    }
  };

  return (
    <>
    <div style={{
      display: 'flex',
      gap: 12,
      padding: '12px 16px',
      overflowX: 'auto',
      overflowY: 'hidden',
      borderTop: '2px solid var(--cth-ink-900)',
      background: 'var(--cth-cream-200)',
      height: 124,
      minHeight: 124,
      alignItems: 'center'
    }}>
      {agents.map(a => (
        <AgentCard
          key={a.id}
          name={a.name}
          accent={a.accent}
          status={a.status}
          project={a.project}
          action={a.action}
          progress={a.progress}
          contextTokens={a.contextTokens}
          contextLimit={a.contextLimit}
          selected={a.id === selectedId}
          isGod={a.isGod}
          onClick={() => select(a.id)}
          doingCount={doingByAgent[a.id]?.length ?? 0}
          onTaskNoteClick={() => {
            const first = doingByAgent[a.id]?.[0];
            if (first) openTaskDetail(first);
          }}
          onPublish={() => openPublish(a)}
          publishState={pubState[a.id] ?? 'idle'}
        />
      ))}
      {restorableAgents.length > 0 && (
        <span
          style={{ alignSelf: 'center', flexShrink: 0 }}
          title={`Respawn from last session: ${restorableAgents.map((a: Agent) => a.name).join(', ')} — same ids, memory and inboxes reattach automatically`}
        >
          <PixelButton
            variant="primary"
            size="lg"
            onClick={restoreTeam}
            disabled={restoring}
          >
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <Icon name="play" /> {restoring ? 'restoring…' : `restore team (${restorableAgents.length})`}
            </span>
          </PixelButton>
        </span>
      )}
      <PixelButton
        variant="secondary"
        size="lg"
        style={{ alignSelf: 'center' }}
        onClick={() => setAddAgentOpen(true)}
      >
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <Icon name="plus" /> add agent
        </span>
      </PixelButton>
    </div>

    {publishTarget && (
      <div
        onClick={() => setPublishTarget(null)}
        style={{
          position: 'fixed', inset: 0, zIndex: 60,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.4)'
        }}
      >
        <div onClick={(e) => e.stopPropagation()} style={{ width: 420, maxWidth: '90vw' }}>
          <PixelPanel variant="dialog" title="PUBLISH AGENT" noPadding>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 14 }}>
              <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: 1.5 }}>
                Publish <b>{publishTarget.name}</b> to the shared agent library so teammates can add it to their hive.
              </div>
              <label style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
                What makes this agent worth sharing? (optional)
              </label>
              <textarea
                value={publishWhy}
                onChange={(e) => setPublishWhy(e.target.value)}
                autoFocus
                rows={3}
                placeholder="e.g. tuned for RealPage TFS + Salesforce SR workflows"
                style={{
                  resize: 'vertical', padding: '6px 8px',
                  background: 'var(--cth-paper-100)', border: 'none',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 13,
                  color: 'var(--cth-ink-900)', outline: 'none'
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <PixelButton variant="ghost" size="sm" onClick={() => setPublishTarget(null)}>Cancel</PixelButton>
                <PixelButton variant="primary" size="sm" onClick={() => { void confirmPublish(); }}>Publish ↑</PixelButton>
              </div>
            </div>
          </PixelPanel>
        </div>
      </div>
    )}
    </>
  );
}
