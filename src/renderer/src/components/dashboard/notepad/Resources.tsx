/**
 * RESOURCES — shared pinned links (docs, dashboards, runbooks) for the workspace.
 * Reads window.cth.listResources() on mount + every ~15s; adds via addResource()
 * and removes via removeResource(). Links open EXTERNALLY (the main-process
 * window-open handler routes target=_blank anchors through shell.openExternal).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Resource } from '../../../../../preload';
import { PixelButton } from '../../PixelButton';

const POLL_MS = 15_000;

/** Loose URL gate — accept http(s):// or a bare host like "wiki.corp/runbook".
 *  We only need to keep accidental blanks/garbage out; the real validation is
 *  the user's eyes + the external open. */
function looksLikeUrl(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  try {
    new URL(s);
    return true;
  } catch {
    // Tolerate scheme-less entries like "example.com/x".
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(s);
  }
}

/** Ensure a clickable href so scheme-less entries still open externally. */
function toHref(url: string): string {
  const s = url.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
}

export function Resources() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const rows = await window.cth.listResources();
      if (mounted.current) setResources(rows);
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

  const canAdd = label.trim().length > 0 && looksLikeUrl(url) && !busy;

  const add = useCallback(async () => {
    if (!canAdd) return;
    setBusy(true);
    try {
      const res = await window.cth.addResource({
        label: label.trim(),
        url: url.trim(),
        note: note.trim() || undefined
      });
      if (res?.ok) {
        setLabel('');
        setUrl('');
        setNote('');
        await refresh();
      }
    } catch {
      /* best-effort */
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [canAdd, label, url, note, refresh]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await window.cth.removeResource(id);
        await refresh();
      } catch {
        /* best-effort */
      }
    },
    [refresh]
  );

  return (
    <Section title="RESOURCES">
      {resources.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--cth-ink-500)', marginBottom: 8 }}>
          No shared links yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
          {resources.map((r) => (
            <ResourceRow key={r.id} resource={r} onRemove={() => void remove(r.id)} />
          ))}
        </div>
      )}

      {/* Add row */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <Input value={label} onChange={setLabel} placeholder="label" />
          <Input value={url} onChange={setUrl} placeholder="https://…" flex={2} />
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <Input value={note} onChange={setNote} placeholder="note (optional)" flex={3} />
          <PixelButton
            variant="primary"
            size="sm"
            onClick={() => void add()}
            disabled={!canAdd}
          >
            Add
          </PixelButton>
        </div>
      </div>
    </Section>
  );
}

function ResourceRow({ resource, onRemove }: { resource: Resource; onRemove: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        padding: '4px 6px',
        background: 'var(--cth-paper-100)',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <a
          href={toHref(resource.url)}
          target="_blank"
          rel="noreferrer noopener"
          title={resource.url}
          style={{
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 12,
            color: 'var(--cth-ink-900)',
            textDecoration: 'underline',
            wordBreak: 'break-word'
          }}
        >
          {resource.label}
        </a>
        <div
          style={{
            fontSize: 10,
            color: 'var(--cth-ink-500)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {resource.url}
        </div>
        {resource.note && (
          <div style={{ fontSize: 11, color: 'var(--cth-ink-700)', wordBreak: 'break-word' }}>
            {resource.note}
          </div>
        )}
        {resource.authorLabel && (
          <div style={{ fontSize: 9, color: 'var(--cth-ink-500)' }}>— {resource.authorLabel}</div>
        )}
      </div>
      <button
        onClick={onRemove}
        title="Remove"
        style={{
          flexShrink: 0,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          color: 'var(--cth-ink-500)',
          fontFamily: 'var(--cth-font-ui)',
          fontSize: 12,
          padding: 0,
          opacity: hover ? 1 : 0,
          transition: 'opacity 120ms'
        }}
      >
        ✕
      </button>
    </div>
  );
}

function Input({
  value,
  onChange,
  placeholder,
  flex = 1
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  flex?: number;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        flex,
        minWidth: 0,
        padding: '4px 6px',
        background: 'var(--cth-cream-100)',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
        border: 'none',
        fontFamily: 'var(--cth-font-ui)',
        fontSize: 12,
        color: 'var(--cth-ink-900)'
      }}
    />
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
