/**
 * Small converters from ClickUp content to TipTap/ProseMirror JSON (the node/mark names used by
 * StarterKit + Link + TaskList/TaskItem + Mention in apps/web/src/components/editor.tsx).
 *
 *  - markdownToRichText: task descriptions (`markdown_description`) and Docs pages (`text/md`).
 *    Handles paragraphs (single newlines become hard breaks), headings, bold/italic/strike/code,
 *    links, images (as links), bullet/ordered/task lists (nested by indentation), code blocks,
 *    block quotes and rules. Anything else stays as plain text.
 *  - commentToRichText: ClickUp comment ops (a Quill delta) incl. mentions and attachments.
 */
export type PMMark = { type: string; attrs?: Record<string, unknown> };
export type PMNode = { type: string; text?: string; marks?: PMMark[]; attrs?: Record<string, unknown>; content?: PMNode[] };
export type RichDoc = { type: 'doc'; content: PMNode[] };

const text = (t: string, marks: PMMark[]): PMNode => (marks.length ? { type: 'text', text: t, marks: [...marks] } : { type: 'text', text: t });
const para = (content: PMNode[]): PMNode => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });

function mergeText(nodes: PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (prev && prev.type === 'text' && n.type === 'text' && JSON.stringify(prev.marks ?? []) === JSON.stringify(n.marks ?? [])) {
      prev.text += n.text ?? '';
    } else if (n.type !== 'text' || n.text) out.push({ ...n });
  }
  return out;
}

const safeHref = (href: string) => (/^(https?:|mailto:|tel:|\/|#)/i.test(href) ? href : /^[\w.-]+\.[a-z]{2,}/i.test(href) ? `https://${href}` : null);

// ───────────── inline markdown ─────────────

export function parseInline(src: string, marks: PMMark[] = []): PMNode[] {
  const out: PMNode[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push(text(buf, marks));
    buf = '';
  };
  const withMark = (m: PMMark) => [...marks.filter((x) => x.type !== m.type), m];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const rest = src.slice(i);
    if (c === '\\' && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!~|>]/.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push(text(src.slice(i + 1, end), [...marks.filter((m) => m.type === 'link'), { type: 'code' }]));
        i = end + 1;
        continue;
      }
    }
    const link = /^!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
    if ((c === '[' || c === '!') && link) {
      const href = safeHref(link[2]);
      flush();
      const label = link[1] || (c === '!' ? 'image' : link[2]);
      if (href) out.push(...parseInline(label, withMark({ type: 'link', attrs: { href } })));
      else out.push(...parseInline(label, marks));
      i += link[0].length;
      continue;
    }
    const auto = /^<(https?:\/\/[^>\s]+)>/.exec(rest);
    if (auto) {
      flush();
      out.push(text(auto[1], withMark({ type: 'link', attrs: { href: auto[1] } })));
      i += auto[0].length;
      continue;
    }
    if ((rest.startsWith('**') || rest.startsWith('__')) && !/\s/.test(src[i + 2] ?? ' ')) {
      const d = rest.slice(0, 2);
      const end = src.indexOf(d, i + 2);
      if (end > i + 2) {
        flush();
        out.push(...parseInline(src.slice(i + 2, end), withMark({ type: 'bold' })));
        i = end + 2;
        continue;
      }
    }
    if (rest.startsWith('~~')) {
      const end = src.indexOf('~~', i + 2);
      if (end > i + 2) {
        flush();
        out.push(...parseInline(src.slice(i + 2, end), withMark({ type: 'strike' })));
        i = end + 2;
        continue;
      }
    }
    if ((c === '*' || c === '_') && !/\s/.test(src[i + 1] ?? ' ') && (c === '*' || !/\w/.test(src[i - 1] ?? ''))) {
      let end = -1;
      for (let j = i + 1; j < src.length; j++) {
        if (src[j] === c && src[j + 1] !== c && src[j - 1] !== c && !/\s/.test(src[j - 1]) && (c === '*' || !/\w/.test(src[j + 1] ?? ''))) {
          end = j;
          break;
        }
      }
      if (end > i + 1) {
        flush();
        out.push(...parseInline(src.slice(i + 1, end), withMark({ type: 'italic' })));
        i = end + 1;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return mergeText(out);
}

/** Inline content for a run of lines: single newlines become hard breaks. */
function inlineLines(lines: string[]): PMNode[] {
  const out: PMNode[] = [];
  lines.forEach((l, i) => {
    if (i > 0) out.push({ type: 'hardBreak' });
    out.push(...parseInline(l.replace(/\s+$/, '')));
  });
  return out;
}

// ───────────── blocks ─────────────

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE_RE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;

const indentOf = (s: string) => s.replace(/\t/g, '    ').length;

function isBlockStart(line: string) {
  return LIST_RE.test(line) || FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line);
}

interface Item { indent: number; kind: 'bullet' | 'ordered' | 'task'; start: number; checked: boolean; lines: string[] }

function buildLists(items: Item[]): PMNode[] {
  const out: PMNode[] = [];
  let i = 0;
  while (i < items.length) {
    const base = items[i].indent;
    const kind = items[i].kind;
    const listNode: PMNode = kind === 'task'
      ? { type: 'taskList', content: [] }
      : kind === 'ordered' ? { type: 'orderedList', attrs: { start: items[i].start }, content: [] } : { type: 'bulletList', content: [] };
    while (i < items.length && items[i].indent <= base && items[i].kind === kind) {
      const it = items[i];
      i++;
      const childStart = i;
      while (i < items.length && items[i].indent > base) i++;
      const content: PMNode[] = [para(inlineLines(it.lines))];
      if (i > childStart) content.push(...buildLists(items.slice(childStart, i)));
      listNode.content!.push(kind === 'task' ? { type: 'taskItem', attrs: { checked: it.checked }, content } : { type: 'listItem', content });
    }
    out.push(listNode);
  }
  return out;
}

function parseBlocks(lines: string[]): PMNode[] {
  const out: PMNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++;
      const code = body.join('\n');
      out.push({ type: 'codeBlock', attrs: { language: fence[2] || null }, ...(code ? { content: [{ type: 'text', text: code }] } : {}) });
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      const content = parseInline(h[2]);
      out.push({ type: 'heading', attrs: { level: h[1].length }, ...(content.length ? { content } : {}) });
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      out.push({ type: 'horizontalRule' });
      i++;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && lines[i].trim() && QUOTE_RE.test(lines[i]); i++) body.push(QUOTE_RE.exec(lines[i])![1]);
      const inner = parseBlocks(body);
      out.push({ type: 'blockquote', content: inner.length ? inner : [para([])] });
      continue;
    }
    if (LIST_RE.test(line)) {
      const items: Item[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = LIST_RE.exec(l);
        if (m) {
          const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
          const ordered = /^\d/.test(m[2]);
          items.push({
            indent: indentOf(m[1]),
            kind: task && !ordered ? 'task' : ordered ? 'ordered' : 'bullet',
            start: ordered ? parseInt(m[2], 10) : 1,
            checked: task ? task[1].toLowerCase() === 'x' : false,
            lines: [task && !ordered ? task[2] : m[3]],
          });
          i++;
          continue;
        }
        if (!l.trim()) {
          // a blank line ends the list unless the next line continues it
          const next = lines[i + 1];
          if (next !== undefined && (LIST_RE.test(next) || (indentOf(/^\s*/.exec(next)![0]) >= 2 && next.trim()))) { i++; continue; }
          break;
        }
        if (indentOf(/^\s*/.exec(l)![0]) >= 2 && items.length && !isBlockStart(l.trimStart())) {
          items[items.length - 1].lines.push(l.trim());
          i++;
          continue;
        }
        if (items.length && !isBlockStart(l)) {
          // lazy continuation line
          items[items.length - 1].lines.push(l.trim());
          i++;
          continue;
        }
        break;
      }
      out.push(...buildLists(items));
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() && (body.length === 0 || !isBlockStart(lines[i]))) body.push(lines[i++]);
    out.push(para(inlineLines(body)));
  }
  return out;
}

/** Markdown → TipTap doc; null for empty input. */
export function markdownToRichText(md: string | null | undefined): RichDoc | null {
  if (!md || !md.trim()) return null;
  const content = parseBlocks(md.replace(/\r\n?/g, '\n').split('\n'));
  return content.length ? { type: 'doc', content } : null;
}

// ───────────── ClickUp comment ops (Quill delta) ─────────────

export interface CommentOp {
  text?: string | null;
  type?: string | null;
  attributes?: Record<string, unknown> | null;
  user?: { id: string; username?: string | null; email?: string | null } | null;
  attachment?: { id?: string | null; title?: string | null; url?: string | null } | null;
}

export interface CommentConversion {
  doc: RichDoc;
  /** files referenced in the comment, to import as comment attachments */
  attachments: Array<{ id: string | null; title: string; url: string }>;
}

function opMarks(a: Record<string, unknown> | null | undefined): PMMark[] {
  if (!a) return [];
  const m: PMMark[] = [];
  if (a.bold) m.push({ type: 'bold' });
  if (a.italic) m.push({ type: 'italic' });
  if (a.strike || a.strikethrough) m.push({ type: 'strike' });
  if (a.code) m.push({ type: 'code' });
  if (typeof a.link === 'string') {
    const href = safeHref(a.link);
    if (href) m.push({ type: 'link', attrs: { href } });
  }
  return m;
}

/**
 * Convert comment ops. `userMap` maps ClickUp user ids to our user ids (mentions of unmapped
 * users become plain `@name` text).
 */
export function commentToRichText(ops: CommentOp[], fallbackText: string | null | undefined, userMap: (cuUserId: string) => string | null): CommentConversion {
  const attachments: CommentConversion['attachments'] = [];
  if (!ops.length) {
    const doc = markdownToRichText(fallbackText ?? '') ?? { type: 'doc' as const, content: [para([])] };
    return { doc, attachments };
  }
  type Line = { inline: PMNode[]; block: Record<string, unknown> };
  const lines: Line[] = [];
  let cur: PMNode[] = [];
  for (const op of ops) {
    if (op.type === 'tag' && op.user) {
      const uid = userMap(String(op.user.id));
      const label = op.user.username ?? op.user.email ?? 'user';
      cur.push(uid ? { type: 'mention', attrs: { id: uid, label } } : text(`@${label}`, []));
      continue;
    }
    if (op.type === 'attachment' && op.attachment?.url) {
      const title = op.attachment.title || 'attachment';
      attachments.push({ id: op.attachment.id ? String(op.attachment.id) : null, title, url: op.attachment.url });
      cur.push(text(title, [{ type: 'link', attrs: { href: op.attachment.url } }]));
      continue;
    }
    const t = op.text ?? '';
    const parts = t.split('\n');
    parts.forEach((p, idx) => {
      if (idx > 0) {
        // the newline op carries the block attributes of the line it ends
        lines.push({ inline: cur, block: op.attributes ?? {} });
        cur = [];
      }
      if (p) cur.push(text(p, opMarks(op.attributes)));
    });
  }
  if (cur.length) lines.push({ inline: cur, block: {} });

  const out: PMNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const { inline, block } = lines[i];
    const content = mergeText(inline);
    const list = typeof block.list === 'string' ? block.list : null;
    if (list) {
      const kind = list === 'ordered' ? 'orderedList' : list === 'checked' || list === 'unchecked' ? 'taskList' : 'bulletList';
      const prev = out[out.length - 1];
      const item: PMNode = kind === 'taskList'
        ? { type: 'taskItem', attrs: { checked: list === 'checked' }, content: [para(content)] }
        : { type: 'listItem', content: [para(content)] };
      if (prev && prev.type === kind) prev.content!.push(item);
      else out.push({ type: kind, ...(kind === 'orderedList' ? { attrs: { start: 1 } } : {}), content: [item] });
      continue;
    }
    if (block.header) {
      out.push({ type: 'heading', attrs: { level: Math.min(6, Math.max(1, Number(block.header) || 1)) }, ...(content.length ? { content } : {}) });
    } else if (block['code-block']) {
      const prev = out[out.length - 1];
      const t = content.map((n) => n.text ?? '').join('');
      if (prev?.type === 'codeBlock') prev.content = [{ type: 'text', text: `${prev.content?.[0]?.text ?? ''}\n${t}` }];
      else out.push({ type: 'codeBlock', attrs: { language: null }, ...(t ? { content: [{ type: 'text', text: t }] } : {}) });
    } else if (block.blockquote) {
      out.push({ type: 'blockquote', content: [para(content)] });
    } else {
      out.push(para(content));
    }
  }
  // drop trailing empty paragraphs (Quill always ends with "\n")
  while (out.length > 1 && out[out.length - 1].type === 'paragraph' && !out[out.length - 1].content) out.pop();
  return { doc: { type: 'doc', content: out.length ? out : [para([])] }, attachments };
}
