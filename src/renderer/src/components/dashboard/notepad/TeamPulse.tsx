/**
 * TEAM PULSE — a horizontal strip of coworker avatars (one per teammate
 * machine, read live from member_notes). Clicking an avatar selects that
 * teammate and shows ONLY their snippet in a detail panel below. The current
 * user (isMe) is editable (textarea + Save → window.cth.setMyPulse); everyone
 * else is read-only. Fetches window.cth.getMemberNotes() on mount + polls ~15s
 * (without clobbering an in-progress edit). Default-selects the current user.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { PixelButton } from '@/components/PixelButton';
import { Avatar } from '@/components/Avatar';
import { Markdown } from '@/components/Markdown';
import type { AccentColorName } from '@/design/tokens';
import type { MemberNote } from '../../../../../preload/index';

const POLL_MS = 15_000;
const ACCENTS: AccentColorName[] = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'];

/** Stable per-machine accent so each teammate keeps the same avatar color. */
function accentFor(machineId: string): AccentColorName {
  let h = 0;
  for (let i = 0; i < machineId.length; i++) h = (h * 31 + machineId.charCodeAt(i)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}

/** A teammate's display label: their owner label (email), else a short machine tag. */
function labelFor(n: MemberNote): string {
  if (n.ownerLabel && n.ownerLabel.trim()) return n.ownerLabel.trim();
  return `teammate ${n.machineId.slice(0, 6)}`;
}

/** Compact relative "Xm ago" from an epoch-ms stamp. */
function relTime(ms: number): string {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  if (d < 0) return 'just now';
  const s = Math.round(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function TeamPulse() {
  const [notes, setNotes] = useState<MemberNote[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const editingRef = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keep a ref in sync so the poll can read the live editing flag.
  editingRef.current = editing;

  const refresh = async () => {
    try {
      const rows = await window.cth.getMemberNotes();
      setNotes(rows);
      // Default-select the current user on first load, else the first teammate.
      setSelectedId((prev) => {
        if (prev && rows.some((r) => r.machineId === prev)) return prev;
        const mine = rows.find((r) => r.isMe);
        return mine?.machineId ?? rows[0]?.machineId ?? null;
      });
    } catch {
      /* best-effort; leave the last good list */
    }
  };

  useEffect(() => {
    refresh();
    timer.current = setInterval(() => {
      // Don't clobber an in-progress edit; the next poll reconciles.
      if (!editingRef.current) refresh();
    }, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  const selected = useMemo(
    () => notes.find((n) => n.machineId === selectedId) ?? null,
    [notes, selectedId]
  );

  const select = (n: MemberNote) => {
    if (n.machineId === selectedId) return;
    setSelectedId(n.machineId);
    setEditing(false);
    setDraft(n.body);
  };

  const beginEdit = () => {
    if (!selected) return;
    setDraft(selected.body);
    setEditing(true);
  };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await window.cth.setMyPulse(draft);
      // Optimistically reflect the new body locally; the next poll reconciles.
      setNotes((rows) =>
        rows.map((r) => (r.isMe ? { ...r, body: draft, updatedAt: Date.now() } : r))
      );
      setEditing(false);
    } catch {
      /* keep the editor open so the user can retry */
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title="TEAM PULSE">
      {notes.length === 0 ? (
        <Muted>No teammates yet.</Muted>
      ) : (
        <>
          {/* Horizontal, wrapping strip of coworker avatars */}
          <div style={stripStyle}>
            {notes.map((n) => {
              const active = n.machineId === selectedId;
              const label = labelFor(n);
              return (
                <button
                  key={n.machineId}
                  onClick={() => select(n)}
                  title={`${label}${n.isMe ? ' (you)' : ''} · ${relTime(n.updatedAt)}`}
                  style={avatarBtnStyle(active)}
                >
                  <Avatar name={label} accent={accentFor(n.machineId)} size={34} />
                  {n.isMe && <span style={youDotStyle} />}
                </button>
              );
            })}
          </div>

          {/* Detail panel for the selected teammate */}
          {selected && (
            <div style={detailStyle}>
              <div style={detailHeadStyle}>
                <Avatar
                  name={labelFor(selected)}
                  accent={accentFor(selected.machineId)}
                  size={22}
                />
                <span style={detailLabelStyle}>{labelFor(selected)}</span>
                {selected.isMe && <span style={youChipStyle}>YOU</span>}
                <span style={detailTimeStyle}>updated {relTime(selected.updatedAt)}</span>
              </div>

              {selected.isMe && editing ? (
                <>
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={3}
                    placeholder="What are you up to? (shown to your teammates)"
                    autoFocus
                    style={textareaStyle}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                    <PixelButton variant="primary" size="sm" onClick={save} disabled={saving}>
                      {saving ? 'saving…' : 'Save'}
                    </PixelButton>
                    <PixelButton
                      variant="secondary"
                      size="sm"
                      onClick={() => { setEditing(false); setDraft(selected.body); }}
                      disabled={saving}
                    >
                      cancel
                    </PixelButton>
                  </div>
                </>
              ) : (
                <>
                  <Body text={selected.body} />
                  {selected.isMe && (
                    <button onClick={beginEdit} style={editLinkStyle}>edit</button>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function Body({ text }: { text: string }) {
  const t = text.trim();
  if (!t) {
    return (
      <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-300)' }}>
        (nothing yet)
      </div>
    );
  }
  return (
    <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)', wordBreak: 'break-word' }}>
      <Markdown source={t} />
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

const stripStyle: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
  maxHeight: 96, overflowY: 'auto', marginBottom: 8
};

function avatarBtnStyle(active: boolean): React.CSSProperties {
  return {
    position: 'relative', padding: 2, border: 'none', cursor: 'pointer',
    borderRadius: '50%', background: 'transparent',
    boxShadow: active ? '0 0 0 2px var(--cth-ink-900)' : 'none',
    transition: 'box-shadow 120ms ease', lineHeight: 0
  };
}

const youDotStyle: React.CSSProperties = {
  position: 'absolute', bottom: 1, right: 1, width: 8, height: 8,
  borderRadius: '50%', background: 'var(--cth-mint)',
  boxShadow: '0 0 0 1.5px var(--cth-paper-100)'
};

const detailStyle: React.CSSProperties = {
  padding: 8,
  background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
};

const detailHeadStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6
};

const detailLabelStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)',
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
};

const youChipStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 7, lineHeight: '12px',
  padding: '1px 5px 0', flexShrink: 0,
  background: 'var(--cth-mint-light)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  color: 'var(--cth-ink-900)'
};

const detailTimeStyle: React.CSSProperties = {
  marginLeft: 'auto', flexShrink: 0, fontSize: 11, color: 'var(--cth-ink-500)'
};

const editLinkStyle: React.CSSProperties = {
  marginTop: 6, padding: '1px 6px', border: 'none', cursor: 'pointer',
  background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)'
};

const textareaStyle: React.CSSProperties = {
  width: '100%', resize: 'none', padding: '6px 8px',
  background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-mono)', fontSize: 13, lineHeight: '17px',
  color: 'var(--cth-ink-900)', outline: 'none', boxSizing: 'border-box'
};
