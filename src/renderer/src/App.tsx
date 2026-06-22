import { useEffect, useState } from 'react';
import { useStore, selectedAgent, teamAgentEntries } from '@/store/store';
import { teamsList, onTeamsEvent } from '@/ipc/teams';
import { startMockLoop, stopMockLoop } from '@/store/mockEvents';
import type { HarnessConfig } from '@/store/config';
import { DashboardView } from '@/components/dashboard/DashboardView';
import { useHive } from '@/hooks/useHive';
import { MemoryPanel } from '@/components/MemoryPanel';
import { AgentDetailPanel } from '@/components/AgentDetailPanel';
import { AddAgentModal } from '@/components/AddAgentModal';
import { BootSplash } from '@/components/BootSplash';
import { OnboardingWizard } from '@/components/OnboardingWizard';
import { QuitWarningModal, type ClosingTimeState } from '@/components/QuitWarningModal';
import { SettingsModal } from '@/components/SettingsModal';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelButton } from '@/components/PixelButton';
import { Icon } from '@/components/Icon';
import { SidebarSplitter } from '@/components/SidebarSplitter';
import { acquireTerminal } from '@/components/terminalPool';
import { FullscreenTerminal } from '@/components/FullscreenTerminal';
import { TaskDetailOverlay } from '@/components/TaskDetailOverlay';
import { FullscreenFileEditor } from '@/components/FullscreenFileEditor';

// Injected at build time from package.json (see electron.vite.config.ts).
declare const __APP_VERSION__: string;

export function App() {
  const agent = useStore(selectedAgent);
  const agents = useStore(s => s.agents);
  const agentCount = agents.length;
  const addAgentOpen = useStore(s => s.addAgentOpen);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const godStatus = useStore(s => s.godStatus);
  const fullscreenAgentId = useStore(s => s.fullscreenAgentId);
  const fullscreenFilePath = useStore(s => s.fullscreenFilePath);
  const sidebarWidth = useStore(s => s.sidebarWidth);
  const setSidebarWidth = useStore(s => s.setSidebarWidth);

  const [config, setConfig] = useState<HarnessConfig | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quitWarn, setQuitWarn] = useState<{ ptyCount: number } | null>(null);
  const [closing, setClosing] = useState<ClosingTimeState | null>(null);
  const [vpWidth, setVpWidth] = useState<number>(window.innerWidth);

  // Initial config load
  useEffect(() => {
    let cancelled = false;
    window.cth.getConfig().then(c => { if (!cancelled) setConfig(c); });
    return () => { cancelled = true; };
  }, []);

  // Multi-team: hydrate the team list from the main process, then keep it live
  // off `teams:event`. A 'created' event (e.g. after a clone) appends the team —
  // useHive's bootstrap effect (dep on teamList) then spawns its god; 'status'
  // refreshes the selector's running/agentCount badges.
  useEffect(() => {
    let cancelled = false;
    teamsList().then((list) => { if (!cancelled) useStore.getState().setTeamList(list); });
    const off = onTeamsEvent((ev) => {
      if (ev.kind === 'created') useStore.getState().upsertTeam(ev.summary);
      else if (ev.kind === 'status') {
        useStore.getState().upsertTeam({ id: ev.teamId, running: ev.running, agentCount: ev.agentCount });
      } else if (ev.kind === 'removed') {
        // Drop the deleted team; the store falls back to the default/first team
        // and switches the dashboard there if it was the active one.
        useStore.getState().removeTeam(ev.teamId);
      }
    });
    return () => { cancelled = true; off(); };
  }, []);

  // Quit warning subscription
  useEffect(() => window.cth.onCloseRequested((info) => setQuitWarn(info)), []);

  // Closing-time progress: drives the quit dialog's "wrapping up" view. The
  // dialog stays up through the whole protocol; on 'complete' the main process
  // tears down and quits by itself moments later.
  useEffect(() => window.cth.onClosingTime?.((ev) => {
    if (ev.phase === 'cancelled') { setClosing(null); return; }
    setClosing({ phase: ev.phase, acked: ev.acked, total: ev.total });
    if (ev.phase === 'started' || ev.phase === 'progress') setQuitWarn((w) => w ?? { ptyCount: 0 });
  }), []);

  const startClosingTime = async () => {
    const res = await window.cth.startClosingTime();
    if (!res.ok) setClosing({ phase: 'error', acked: 0, total: 0, error: res.error });
  };
  const cancelClosingTime = () => {
    void window.cth.cancelClosingTime();
    setClosing(null);
  };

  // The hive: god-agent bootstrap, hook-driven avatars, idle-agent waking.
  useHive(config);

  // Pre-warm a persistent terminal for every live agent so its output is
  // buffered from spawn. Switching agents/teams then re-attaches an already-
  // rendered terminal instantly (with full history) instead of building a blank
  // one. ALL teams (not just the active one) are pre-warmed so background teams'
  // streams keep buffering off-screen and a team switch is instant (FE-6/§7.7).
  const teams = useStore((s) => s.teams);
  useEffect(() => {
    for (const { agent: a } of teamAgentEntries(useStore.getState())) {
      if (a.ptyId) acquireTerminal(a.ptyId);
    }
  }, [teams]);

  // Synthetic demo loop — CAGED (#5B). It must never animate alongside a live
  // hive (it would fire fake envelope handoffs and step seeded agents). Run it
  // only as an explicit showcase (VITE_CTH_DEMO=1 in dev) or on a genuinely
  // empty team, and stop it the instant the first real PTY agent appears
  // (the orchestrator always spawns, so in normal operation it effectively never runs).
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const DEMO = import.meta.env.DEV && import.meta.env.VITE_CTH_DEMO === '1';
    const evaluate = () => {
      const hasLive = useStore.getState().agents.some((a) => a.ptyId);
      if (DEMO || !hasLive) startMockLoop();
      else stopMockLoop();
    };
    evaluate();
    const unsub = useStore.subscribe(evaluate);
    return () => { unsub(); stopMockLoop(); };
  }, [config?.onboardingComplete]);

  // Reconcile restored agents against the PTYs still alive in the main process.
  // After a renderer reload (e.g. the laptop slept and Vite reloaded the page),
  // this keeps agents whose process survived and drops any that truly died.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    let cancelled = false;
    window.cth.listPtys().then((list) => {
      if (cancelled) return;
      useStore.getState().reconcileWithLivePtys(list.map((p) => p.id));
    }).catch(() => { /* ignore — keep restored agents as-is */ });
    return () => { cancelled = true; };
  }, [config?.onboardingComplete]);

  // Track viewport width for splitter clamping
  useEffect(() => {
    const onResize = () => setVpWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (!config) {
    return <div style={{ width: '100vw', height: '100vh', background: 'var(--cth-cream-100)' }} />;
  }

  if (!config.onboardingComplete) {
    return <OnboardingWizard onComplete={(next) => setConfig(next)} />;
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      width: '100vw', height: '100vh',
      overflow: 'hidden'
    }}>
      {/* Title bar */}
      <div
        className="cth-titlebar-drag"
        style={{
          height: 38, minHeight: 38,
          background: 'linear-gradient(180deg, var(--cth-cream-50) 0%, var(--cth-cream-100) 100%)',
          borderBottom: '1px solid var(--cth-ink-100)',
          boxShadow: '0 1px 2px rgba(16,24,40,0.04)',
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 96,
          paddingRight: 12,
          gap: 12,
          userSelect: 'none'
        }}
      >
        <span style={{
          fontFamily: 'var(--cth-font-display)',
          fontSize: 14,
          fontWeight: 700,
          letterSpacing: '0.02em',
          color: 'var(--cth-ink-900)',
          display: 'block'
        }}>
          Hive
        </span>
        <span style={{
          fontFamily: 'var(--cth-font-ui)',
          fontSize: 14,
          color: 'var(--cth-ink-500)'
        }}>
          v{__APP_VERSION__} · {config.autoMode ? 'auto mode on' : 'auto mode off'}
        </span>
        <button
          className="cth-titlebar-nodrag cth-settings-btn"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          aria-label="Settings"
          style={{
            marginLeft: 'auto',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, padding: 0,
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
            border: 'none', borderRadius: 'var(--cth-radius-md)', cursor: 'pointer',
            color: 'var(--cth-ink-700)'
          }}
        >
          <Icon name="gear" size={1} style={{ width: 18, height: 18 }} />
        </button>
      </div>

      <div style={{
        flex: 1, minHeight: 0,
        display: 'flex',
        padding: 16,
        gap: 0
      }}>
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: 'relative' }}>
          <DashboardView />
          <MemoryPanel />
          {agentCount === 0 && godStatus === 'booting' && <BootSplash />}
          {agentCount === 0 && godStatus !== 'booting' && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              pointerEvents: 'none'
            }}>
              <div style={{ pointerEvents: 'auto', width: 360 }}>
                <PixelPanel variant="dialog" title="No agents yet" noPadding>
                  <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <p style={{ margin: 0, fontSize: 14, lineHeight: '20px' }}>
                      No agents yet. Spawn one to see real claude output stream in here.
                    </p>
                    <PixelButton variant="primary" size="md" onClick={() => setAddAgentOpen(true)}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Icon name="plus" /> add agent
                      </span>
                    </PixelButton>
                  </div>
                </PixelPanel>
              </div>
            </div>
          )}
        </div>

        <SidebarSplitter
          width={sidebarWidth}
          onChange={setSidebarWidth}
          viewportWidth={vpWidth}
        />

        <div style={{
          width: sidebarWidth, flexShrink: 0,
          minHeight: 0, display: 'flex', flexDirection: 'column'
        }}>
          {agent ? (
            <AgentDetailPanel agent={agent} />
          ) : godStatus === 'booting' ? (
            <PixelPanel variant="default" noPadding style={{
              padding: 16, height: '100%',
              display: 'flex', flexDirection: 'column',
              justifyContent: 'center', alignItems: 'center', gap: 12
            }}>
              <div style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
                color: 'var(--cth-ink-500)'
              }}>STARTING UP</div>
              <p style={{ margin: 0, fontSize: 14, textAlign: 'center', color: 'var(--cth-ink-700)' }}>
                The orchestrator is coming online.<br />
                The terminal will land here once it's ready.
              </p>
            </PixelPanel>
          ) : (
            <PixelPanel variant="default" noPadding style={{
              padding: 16, height: '100%',
              display: 'flex', flexDirection: 'column',
              justifyContent: 'center', alignItems: 'center', gap: 12
            }}>
              <div style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
                color: 'var(--cth-ink-500)'
              }}>NO AGENT SELECTED</div>
              <p style={{ margin: 0, fontSize: 14, textAlign: 'center', color: 'var(--cth-ink-700)' }}>
                Add an agent from the Team panel.<br />
                The terminal and command bar will land here.
              </p>
              <PixelButton variant="secondary" size="md" onClick={() => setAddAgentOpen(true)}>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <Icon name="plus" /> add agent
                </span>
              </PixelButton>
            </PixelPanel>
          )}
        </div>
      </div>

      {addAgentOpen && (
        <AddAgentModal onClose={() => setAddAgentOpen(false)} config={config} />
      )}

      {settingsOpen && (
        <SettingsModal config={config} onClose={() => setSettingsOpen(false)} />
      )}

      {quitWarn && (
        <QuitWarningModal
          ptyCount={quitWarn.ptyCount}
          closing={closing}
          onCancel={() => {
            if (closing) cancelClosingTime();
            window.cth.cancelClose();
            setQuitWarn(null);
          }}
          onConfirm={async () => { await window.cth.confirmClose(); }}
          onClosingTime={startClosingTime}
        />
      )}

      {fullscreenAgentId && <FullscreenTerminal />}
      {fullscreenFilePath && <FullscreenFileEditor />}
      <TaskDetailOverlay />
    </div>
  );
}
