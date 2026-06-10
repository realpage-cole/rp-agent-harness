/**
 * Markdown — a lightweight, DEPENDENCY-FREE markdown renderer for SHARED content
 * (board entries authored by teammates + agents). It never injects raw HTML: the
 * source is fully HTML-escaped first, then ONLY the supported markdown constructs
 * are turned back into React elements. No dangerouslySetInnerHTML anywhere.
 *
 * Supported:
 *   - headings  # .. ######
 *   - **bold**, *italic*, `inline code`
 *   - fenced ```code blocks```
 *   - unordered (-, *) + ordered (1.) lists
 *   - > blockquotes
 *   - [text](url) links — http(s) only, opened externally
 *   - paragraphs + soft line breaks
 *
 * SECURITY: the inline parser walks raw (un-escaped) source and emits React nodes
 * directly — React escapes any text it renders, so there is no HTML-injection
 * surface. Links are gated to http(s) and rendered as target=_blank anchors with
 * rel="noreferrer noopener" (the app's window-open handler routes those through
 * shell.openExternal). A non-http(s) link target renders as inert text.
 */
import React, { type ReactNode } from 'react';

const C = {
  ink900: 'var(--cth-ink-900)',
  ink700: 'var(--cth-ink-700)',
  ink500: 'var(--cth-ink-500)',
  ink300: 'var(--cth-ink-300)',
  paper100: 'var(--cth-paper-100)',
  paper200: 'var(--cth-paper-200)',
  mono: 'var(--cth-font-mono)',
  ui: 'var(--cth-font-ui)'
};

/** Only http(s) URLs are clickable; everything else renders as plain text. */
function safeHref(url: string): string | null {
  const s = url.trim();
  if (/^https?:\/\//i.test(s)) return s;
  return null;
}

// ─── inline parser: **bold** *italic* `code` [text](url) ─────────────────────

let keySeq = 0;
function k(): string {
  return `md${keySeq++}`;
}

/** Parse inline markdown in `text` into React nodes. Recursive for nested
 *  emphasis (e.g. **bold with *italic***). `code` spans are terminal — their
 *  contents are never re-parsed. */
function parseInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let buf = '';
  const flush = (): void => {
    if (buf) { out.push(buf); buf = ''; }
  };

  while (i < text.length) {
    const ch = text[i];

    // inline code — highest precedence, contents are literal
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        flush();
        out.push(
          <code
            key={k()}
            style={{
              fontFamily: C.mono, fontSize: '0.92em', padding: '1px 4px',
              background: C.paper200, boxShadow: `inset 0 0 0 1px ${C.ink300}`,
              color: C.ink900, borderRadius: 2, wordBreak: 'break-word'
            }}
          >{text.slice(i + 1, end)}</code>
        );
        i = end + 1;
        continue;
      }
    }

    // [text](url) links
    if (ch === '[') {
      const close = text.indexOf(']', i + 1);
      if (close !== -1 && text[close + 1] === '(') {
        const paren = text.indexOf(')', close + 2);
        if (paren !== -1) {
          const label = text.slice(i + 1, close);
          const url = text.slice(close + 2, paren);
          const href = safeHref(url);
          flush();
          if (href) {
            out.push(
              <a
                key={k()}
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                style={{ color: C.ink900, textDecoration: 'underline', wordBreak: 'break-word' }}
              >{parseInline(label)}</a>
            );
          } else {
            // Unsupported scheme — render the label as plain text, no link.
            out.push(...parseInline(label));
          }
          i = paren + 1;
          continue;
        }
      }
    }

    // **bold**
    if (ch === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        flush();
        out.push(<strong key={k()}>{parseInline(text.slice(i + 2, end))}</strong>);
        i = end + 2;
        continue;
      }
    }

    // *italic*
    if (ch === '*') {
      const end = text.indexOf('*', i + 1);
      if (end !== -1 && end !== i + 1) {
        flush();
        out.push(<em key={k()}>{parseInline(text.slice(i + 1, end))}</em>);
        i = end + 1;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

// ─── block parser ────────────────────────────────────────────────────────────

const FENCE = /^```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const UL = /^[-*]\s+(.*)$/;
const OL = /^\d+\.\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

const headingSizes = ['1.4em', '1.25em', '1.12em', '1.04em', '0.98em', '0.92em'];

function renderBlocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    if (FENCE.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // consume closing fence (or run off the end)
      blocks.push(
        <pre
          key={k()}
          style={{
            margin: '8px 0', padding: '8px 10px', overflow: 'auto',
            background: C.paper200, boxShadow: `inset 0 0 0 1px ${C.ink300}`,
            borderRadius: 3, fontFamily: C.mono, fontSize: 12, lineHeight: '17px',
            color: C.ink900, whiteSpace: 'pre-wrap', wordBreak: 'break-word'
          }}
        >{code.join('\n')}</pre>
      );
      continue;
    }

    // heading
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      blocks.push(
        <div
          key={k()}
          role="heading"
          aria-level={level}
          style={{
            fontFamily: C.ui, fontWeight: 700, fontSize: headingSizes[level - 1],
            lineHeight: 1.3, color: C.ink900, margin: '10px 0 4px'
          }}
        >{parseInline(h[2])}</div>
      );
      i++;
      continue;
    }

    // blockquote (consecutive > lines)
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(QUOTE.exec(lines[i])![1]);
        i++;
      }
      blocks.push(
        <blockquote
          key={k()}
          style={{
            margin: '8px 0', padding: '2px 0 2px 10px',
            borderLeft: `3px solid ${C.ink300}`, color: C.ink700, fontStyle: 'italic'
          }}
        >{renderBlocks(quoted.join('\n'))}</blockquote>
      );
      continue;
    }

    // lists (unordered / ordered) — a run of matching list lines
    if (UL.test(line) || OL.test(line)) {
      const ordered = OL.test(line);
      const re = ordered ? OL : UL;
      const items: ReactNode[] = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push(<li key={k()} style={{ margin: '2px 0' }}>{parseInline(re.exec(lines[i])![1])}</li>);
        i++;
      }
      const listStyle: React.CSSProperties = { margin: '6px 0', paddingLeft: 22, lineHeight: '18px' };
      blocks.push(
        ordered
          ? <ol key={k()} style={listStyle}>{items}</ol>
          : <ul key={k()} style={listStyle}>{items}</ul>
      );
      continue;
    }

    // blank line — skip
    if (line.trim() === '') { i++; continue; }

    // paragraph — gather consecutive non-blank, non-block lines; soft line breaks
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !QUOTE.test(lines[i]) &&
      !UL.test(lines[i]) &&
      !OL.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    const nodes: ReactNode[] = [];
    para.forEach((p, idx) => {
      if (idx > 0) nodes.push(<br key={k()} />);
      nodes.push(...parseInline(p));
    });
    blocks.push(
      <p key={k()} style={{ margin: '6px 0', lineHeight: '18px', wordBreak: 'break-word' }}>{nodes}</p>
    );
  }

  return blocks;
}

export function Markdown({ source }: { source: string }) {
  return (
    <div style={{ fontFamily: C.ui, fontSize: 13, color: C.ink900 }}>
      {renderBlocks(source ?? '')}
    </div>
  );
}
