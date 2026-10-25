/** Helpers for TipTap/ProseMirror JSON. Mention nodes are `{type:'mention', attrs:{id, label}}`. */
type Node = { type?: string; text?: string; attrs?: Record<string, unknown>; content?: Node[] };

const BLOCKS = new Set(['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock', 'taskItem']);

export function richTextToPlain(doc: unknown): string {
  const out: string[] = [];
  const walk = (n: Node) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'text' && n.text) out.push(n.text);
    else if (n.type === 'mention') out.push(`@${String(n.attrs?.label ?? '')}`);
    else if (n.type === 'taskRef') out.push(String(n.attrs?.label ?? n.attrs?.key ?? ''));
    else if (n.type === 'hardBreak') out.push('\n');
    n.content?.forEach(walk);
    if (n.type && BLOCKS.has(n.type)) out.push('\n');
  };
  walk(doc as Node);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

export function extractMentions(doc: unknown): string[] {
  const ids = new Set<string>();
  const walk = (n: Node) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'mention' && typeof n.attrs?.id === 'string') ids.add(n.attrs.id);
    n.content?.forEach(walk);
  };
  walk(doc as Node);
  return [...ids];
}

export function plainToRichText(text: string) {
  const paragraphs = text.split(/\n{2,}/);
  return {
    type: 'doc' as const,
    content: paragraphs.map((p) => ({
      type: 'paragraph',
      content: p
        ? p.split('\n').flatMap((line, i) => [
            ...(i > 0 ? [{ type: 'hardBreak' }] : []),
            ...(line ? [{ type: 'text', text: line }] : []),
          ])
        : [],
    })),
  };
}
