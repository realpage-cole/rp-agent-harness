/**
 * HUMAN BOARD — "Team notes". Human-authored notes shared across the workspace.
 *
 * Fetches window.cth.listBoardEntries('human') on mount + polls ~20s. An add box
 * at the top (markdown textarea → addBoardEntry({ board:'human', body }), with a
 * live preview + "markdown supported" hint) posts a note, then refreshes + clears.
 * Below, newest-first cards: each with a human AUTHOR CHIP (Avatar initials +
 * authorLabel), relative time, body via <Markdown/>, and a delete affordance
 * (removeBoardEntry) — at least on your own entries (isMine).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { PixelButton } from '@/components/PixelButton';
import { Avatar } from '@/components/Avatar';
import { Markdown } from '@/components/Markdown';
import type { AccentColorName } from '@/design/tokens';
import type { BoardEntry } from '../../../../../preload';

const POLL_MS = 20_000;
const ACCENTS: AccentColorName[] = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'];

/** Stable per-author accent so each teammate keeps the same avatar color. */
function accentFor(key: string): AccentColorName {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}

/** A human author's display label: their email/label, else a generic fallback. */
function labelFor(e: BoardEntry): string {
  const l = e.authorLabel?.trim();
  return l && l.length ? l : 'teammate';
}

/** Compact relative time from an ISO timestamp (e.g. "3m ago"). */
function relTime(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const d = Date.now() - ms;
  if (d < 0) return 'just now';
  const s = Math.round(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.round(h / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function HumanBoard() {
  const [entries, setEntries] = useState<BoardEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const rows = await window.cth.listBoardEntries('human');
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

  const canPost = draft.trim().length > 0 && !busy;

  const post = useCallback(async () => {
    if (!canPost) return;
    setBusy(true);
    try {
      const res = await window.cth.addBoardEntry({ board: 'human', body: draft.trim() });
      if (res?.ok) {
        setDraft('');
        setPreview(false);
        await refresh();
      }
    } catch {
      /* best-effort: keep the draft so the user can retry */
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [canPost, draft, refresh]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await window.cth.removeBoardEntry(id);
        await refresh();
      } catch {
        /* best-effort */
      }
    },
    [refresh]
  );

  // Cmd/Ctrl+Enter posts, matching the muscle memory of a quick note box.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void post();
    }
  };

  return (
    <Section title="TEAM NOTES">
      {/* Add box */}
      <div style={{ marginBottom: 10 }}>
        {preview ? (
          <div style={previewStyle}>
            {draft.trim() ? (
              <Markdown source={draft} />
            ) : (
              <span style={{ color: 'var(--cth-ink-300)' }}>(nothing to preview)</span>
            )}
          </div>
        ) : (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
            placeholder="Share a note with the team… (markdown supported)"
            style={textareaStyle}
          />
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <PixelButton variant="primary" size="sm" onClick={() => void post()} disabled={!canPost}>
            {busy ? 'posting…' : 'Post'}
          </PixelButton>
          <button
            onClick={() => setPreview((p) => !p)}
            disabled={!draft.trim()}
            style={{
              ...toggleStyle,
              opacity: draft.trim() ? 1 : 0.4,
              cursor: draft.trim() ? 'pointer' : 'default'
            }}
          >
            {preview ? 'edit' : 'preview'}
          </button>
          <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--cth-ink-500)' }}>
            markdown supported · ⌘↵ to post
          </span>
        </div>
      </div>

      {/* Entries — newest first */}
      {entries.length === 0 ? (
        <Muted>No team notes yet — add one.</Muted>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {entries.map((e) => (
            <EntryCard key={e.id} entry={e} onRemove={() => void remove(e.id)} />
          ))}
        </div>
      )}
    </Section>
  );
}

function EntryCard({ entry, onRemove }: { entry: BoardEntry; onRemove: () => void }) {
  const [hover, setHover] = useState(false);
  const label = labelFor(entry);
  // Humans may delete any entry, but surface the affordance on your own by default.
  const showDelete = hover || entry.isMine;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: 8,
        background: 'var(--cth-paper-100)',
        boxShadow: entry.isMine
          ? 'inset 0 0 0 1px var(--cth-ink-700)'
          : 'inset 0 0 0 1px var(--cth-ink-300)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <Avatar name={label} accent={accentFor(label)} size={22} />
        <span
          style={{
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 13,
            color: 'var(--cth-ink-900)',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
          title={label}
        >
          {label}
        </span>
        {entry.isMine && (
          <span style={youChipStyle}>YOU</span>
        )}
        <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 11, color: 'var(--cth-ink-500)' }}>
          {relTime(entry.createdAt)}
        </span>
        <button
          onClick={onRemove}
          title="Delete"
          style={{
            flexShrink: 0,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--cth-ink-500)',
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 12,
            padding: 0,
            opacity: showDelete ? 1 : 0,
            transition: 'opacity 120ms'
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)', wordBreak: 'break-word' }}>
        <Markdown source={entry.body} />
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

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{children}</div>;
}

const textareaStyle: React.CSSProperties = {
  width: '100%',
  resize: 'vertical',
  padding: '6px 8px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-mono)',
  fontSize: 13,
  lineHeight: '17px',
  color: 'var(--cth-ink-900)',
  outline: 'none',
  boxSizing: 'border-box'
};

const previewStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 58,
  padding: '6px 8px',
  background: 'var(--cth-paper-100)',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontSize: 12,
  lineHeight: '16px',
  color: 'var(--cth-ink-700)',
  boxSizing: 'border-box',
  wordBreak: 'break-word'
};

const toggleStyle: React.CSSProperties = {
  padding: '1px 8px',
  border: 'none',
  background: 'var(--cth-cream-200)',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 11,
  color: 'var(--cth-ink-900)'
};

const youChipStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-display)',
  fontSize: 7,
  lineHeight: '12px',
  padding: '1px 5px 0',
  flexShrink: 0,
  background: 'var(--cth-mint-light)',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  color: 'var(--cth-ink-900)'
};
