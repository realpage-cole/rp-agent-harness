/**
 * AGENT BOARD — "Agent ideas". Forward-looking project/feature ideas posted by
 * the harness THOUGHTS service (author_kind 'agent', board 'agent'), rendered
 * newest-first as markdown cards. Each card shows an agent author chip + relative
 * time and the body via <Markdown>. NO add box — entries land automatically from
 * the scheduled thoughts service (11am & 3pm Central); humans may delete (curate)
 * agent entries via a subtle per-card affordance.
 *
 * Fetches window.cth.listBoardEntries('agent') on mount + polls ~20s. Best-effort:
 * a failed fetch leaves the last good list in place; an empty list shows a muted
 * explainer.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardEntry } from '../../../../../preload';
import { Markdown } from '@/components/Markdown';

const POLL_MS = 20_000;

/** ISO timestamp -> short relative label ("3m ago", "2h ago", "5d ago"). */
function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function AgentBoard() {
  const [entries, setEntries] = useState<BoardEntry[]>([]);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const rows = await window.cth.listBoardEntries('agent');
      if (mounted.current) setEntries(rows);
    } catch {
      /* best-effort: leave the last good list in place */
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(t);
    };
  }, [refresh]);

  const remove = useCallback(
    async (id: string) => {
      // Optimistic: drop locally, then reconcile from the source of truth.
      setEntries((prev) => prev.filter((e) => e.id !== id));
      try {
        await window.cth.removeBoardEntry(id);
      } catch {
        /* best-effort */
      }
      await refresh();
    },
    [refresh]
  );

  return (
    <Section title="AGENT IDEAS">
      {entries.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            lineHeight: '16px',
            color: 'var(--cth-ink-500)'
          }}
        >
          Agent ideas land here automatically (11am &amp; 3pm Central) —
          project/feature suggestions based on recent work.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {entries.map((e) => (
            <IdeaCard key={e.id} entry={e} onRemove={() => void remove(e.id)} />
          ))}
        </div>
      )}
    </Section>
  );
}

function IdeaCard({ entry, onRemove }: { entry: BoardEntry; onRemove: () => void }) {
  const [hover, setHover] = useState(false);
  const author = entry.authorLabel?.trim() || entry.agentId || 'orchestrator';
  const when = timeAgo(entry.createdAt);

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: 'var(--cth-paper-100)',
        borderRadius: 8,
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
        padding: '8px 10px'
      }}
    >
      {/* Header: agent chip + relative time + delete */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <AgentChip label={author} />
        {when && (
          <span style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>{when}</span>
        )}
        <button
          onClick={onRemove}
          title="Dismiss idea"
          aria-label="Dismiss idea"
          style={{
            marginLeft: 'auto',
            flexShrink: 0,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--cth-ink-500)',
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 12,
            lineHeight: 1,
            padding: 0,
            opacity: hover ? 1 : 0,
            transition: 'opacity 120ms'
          }}
        >
          ✕
        </button>
      </div>

      {/* Body */}
      <div style={{ fontSize: 12, color: 'var(--cth-ink-900)' }}>
        <Markdown source={entry.body} />
      </div>
    </div>
  );
}

/** A small robot badge distinguishing agent-authored entries from human ones. */
function AgentChip({ label }: { label: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        maxWidth: '70%',
        padding: '1px 7px 1px 5px',
        borderRadius: 999,
        background: 'var(--cth-violet-light, var(--cth-paper-200))',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
        fontFamily: 'var(--cth-font-ui)',
        fontSize: 10,
        lineHeight: '16px',
        color: 'var(--cth-ink-700)'
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 11 }}>
        🤖
      </span>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {label}
      </span>
    </span>
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
