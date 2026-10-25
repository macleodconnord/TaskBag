import { richTextToPlain } from '@app/shared';
import { eq } from 'drizzle-orm';
import { docs, folders, lists, spaces } from '../../../db/schema';
import { runTx } from '../../../lib/tx';
import type { CuDoc, CuPage } from '../clickup/schemas';
import { checksum, type ImportContext } from '../context';
import { markdownToRichText } from '../markdown';

/** v3 doc parent types */
const PARENT_TYPES: Record<number, 'space' | 'folder' | 'list'> = { 4: 'space', 5: 'folder', 6: 'list' };
const TABLES = { space: spaces, folder: folders, list: lists } as const;

interface DocNode {
  ext: string;
  title: string;
  markdown: string;
  archived: boolean;
  creator: string | null;
  createdAt: number | null;
  children: DocNode[];
}

/** One ClickUp doc → a doc here; with several pages the pages become nested child docs. */
function toNodes(doc: CuDoc, pages: CuPage[]): DocNode {
  const page = (p: CuPage): DocNode => ({
    ext: `page:${p.id}`, title: p.name.slice(0, 200), markdown: p.content, archived: !!p.archived,
    creator: p.creator_id ?? doc.creator, createdAt: p.date_created ?? doc.date_created, children: p.pages.map(page),
  });
  const root: DocNode = {
    ext: `doc:${doc.id}`, title: doc.name.slice(0, 200), markdown: '', archived: !!doc.archived, creator: doc.creator,
    createdAt: doc.date_created, children: [],
  };
  if (pages.length === 1 && !pages[0].pages.length) root.markdown = pages[0].content;
  else root.children = pages.map(page);
  return root;
}

/** Stage 7: Docs (v3) → docs, nesting preserved; ACL = the container's scope. */
export async function runDocs(ctx: ImportContext) {
  if (!ctx.options.includeDocs) return;
  const all = (await ctx.api.getDocs()).filter((d) => !d.deleted);
  for (let i = ctx.cursor.pos!.docs ?? 0; i < all.length; i++) {
    const d = all[i];
    try {
      await importDoc(ctx, d);
    } catch (err) {
      ctx.stat('doc', 'failed');
      ctx.issue('error', 'doc', d.id, `Doc "${d.name}" failed: ${(err as Error).message}`);
    }
    ctx.cursor.pos!.docs = i + 1;
    ctx.progress(i + 1, all.length, d.name);
    await ctx.checkpoint();
  }
}

async function importDoc(ctx: ImportContext, d: CuDoc) {
  const containerType = d.parent ? PARENT_TYPES[d.parent.type] : undefined;
  if (!containerType || !d.parent) {
    ctx.stat('doc', 'skipped');
    ctx.issue('warn', 'doc', d.id, `Doc "${d.name}" lives at workspace level (or on a task) in ClickUp; docs here belong to a space, folder or list — not imported`);
    return;
  }
  const containerExt = d.parent.id;
  const inPlan = containerType === 'space' ? ctx.plan!.spaces.some((s) => s.id === containerExt)
    : containerType === 'folder' ? ctx.plan!.folders.some((f) => f.cu.id === containerExt) : ctx.plan!.lists.some((l) => l.cu.id === containerExt);
  const containerId = await ctx.idOf(containerType, containerExt);
  if (!inPlan && !containerId) {
    ctx.stat('doc', 'skipped');
    ctx.issue('warn', 'doc', d.id, `Doc "${d.name}": its ${containerType} ${containerExt} is not part of the import`);
    return;
  }
  const root = toNodes(d, await ctx.api.getDocPages(d.id));

  const visit = async (n: DocNode, parentDocId: string | null, position: number) => {
    ctx.stat('doc', 'seen');
    const content = markdownToRichText(n.markdown);
    const sum = checksum({ title: n.title, md: n.markdown, archived: n.archived, parent: parentDocId ? 1 : 0 });
    const mapped = await ctx.lookup('doc', n.ext);
    let id: string | null = mapped?.id ?? null;
    if (ctx.dry) {
      ctx.stat('doc', !mapped ? 'created' : mapped.checksum === sum ? 'unchanged' : 'updated');
    } else if (mapped && mapped.checksum === sum) {
      ctx.stat('doc', 'unchanged');
      await ctx.touch('doc', [n.ext]);
    } else {
      id = await runTx(async (tx) => {
        const [existing] = mapped ? await tx.select().from(docs).where(eq(docs.id, mapped.id)) : [];
        const values = {
          title: n.title || 'Untitled', content, contentText: content ? richTextToPlain(content) : '',
          archivedAt: n.archived ? (existing?.archivedAt ?? new Date()) : null,
        };
        let docId: string;
        if (existing) {
          await tx.update(docs).set({ ...values, updatedBy: ctx.systemUserId }).where(eq(docs.id, existing.id));
          docId = existing.id;
          ctx.stat('doc', 'updated');
        } else {
          const t = TABLES[containerType];
          const [scope] = parentDocId
            ? await tx.select({ s: docs.aclScopeId }).from(docs).where(eq(docs.id, parentDocId))
            : await tx.select({ s: t.aclScopeId }).from(t).where(eq(t.id, containerId!));
          const created = n.createdAt ? new Date(n.createdAt) : new Date();
          const [row] = await tx.insert(docs).values({
            workspaceId: ctx.workspaceId, parentDocId, containerType, containerId: containerId!, ...values,
            aclScopeId: scope.s, position, createdBy: ctx.author(n.creator), createdAt: created, updatedAt: created,
          }).returning({ id: docs.id });
          docId = row.id;
          ctx.stat('doc', 'created');
        }
        await ctx.link(tx, 'doc', n.ext, docId, sum);
        return docId;
      });
    }
    for (const [i, c] of n.children.entries()) await visit(c, id, i);
  };
  await visit(root, null, 0);
}

