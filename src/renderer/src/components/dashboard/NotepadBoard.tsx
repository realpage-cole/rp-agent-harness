import { PixelPanel } from '@/components/PixelPanel';
import { TeamPulse } from './notepad/TeamPulse';
import { AgentBoard } from './notepad/AgentBoard';
import { HumanBoard } from './notepad/HumanBoard';
import { AgentLibrary } from './notepad/AgentLibrary';
import { Resources } from './notepad/Resources';

/**
 * The Notepad center-panel surface — the shared, team-wide companion to the task
 * kanban. Stacks the sections in a single scrollable column: team pulse, the two
 * attributed boards (agent ideas + team notes), the agent library, and pinned
 * links. Each section fetches its own data via the window.cth notepad IPC; this
 * shell only composes them + provides the spacing/dividers.
 *
 * The old single-textarea Scratchpad (the hive's coordination board.md) is no
 * longer surfaced here — it lives on in the Command Center's Activity tab.
 */
export function NotepadBoard() {
  return (
    <PixelPanel title="NOTEPAD" style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }} noPadding>
      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: 18,
        padding: 14, background: 'var(--cth-paper-200)'
      }}>
        <Block><TeamPulse /></Block>
        <Block><AgentBoard /></Block>
        <Block><HumanBoard /></Block>
        <Block><AgentLibrary /></Block>
        <Block><Resources /></Block>
      </div>
    </PixelPanel>
  );
}

/** A surface card around each section — gives the modernized layout breathing
 *  room + a clean panel edge instead of bare stacked sections. */
function Block({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: 12,
      background: 'var(--cth-cream-100)',
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
      borderRadius: 3
    }}>
      {children}
    </div>
  );
}
