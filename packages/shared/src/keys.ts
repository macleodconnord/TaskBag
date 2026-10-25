/** Task references used by integrations: `OPS-142` (space prefix + seq) and `#k3x9a2bq` (short id). */
const KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/g;
const SHORT_RE = /(?:^|[^\w])#([a-z0-9]{8})\b/g;

export function parseTaskRefs(text: string): { keys: string[]; shortIds: string[] } {
  const keys = new Set<string>();
  const shortIds = new Set<string>();
  for (const m of text.matchAll(KEY_RE)) keys.add(`${m[1]}-${m[2]}`);
  for (const m of text.matchAll(SHORT_RE)) shortIds.add(m[1]);
  return { keys: [...keys], shortIds: [...shortIds] };
}

export const slugify = (s: string, max = 40) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
