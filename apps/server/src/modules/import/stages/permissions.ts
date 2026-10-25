import { getSharing, setSharing, type ShareEntryInput } from '../../../lib/acl';
import { runTx } from '../../../lib/tx';
import type { CuUser } from '../clickup/schemas';
import type { ImportContext } from '../context';

type Members = Array<{ user?: CuUser } | CuUser> | null | undefined;
const memberIds = (m: Members) => (m ?? []).map((x) => (x as { user?: CuUser }).user?.id ?? (x as CuUser).id).filter(Boolean).map(String);

/** ClickUp permission_level → ours (Business plan: view/comment/edit/full; unknown → edit, per permissions.md §7). */
const levelFor = (p: string | null | undefined): ShareEntryInput['level'] =>
  p === 'read' ? 'view' : p === 'comment' ? 'comment' : p === 'create' || p === 'full' ? 'full' : 'edit';

const same = (a: ShareEntryInput[], b: ShareEntryInput[]) => {
  const k = (e: ShareEntryInput) => `${e.principalType}:${e.principalId}:${e.level}`;
  return a.length === b.length && a.map(k).sort().join() === b.map(k).sort().join();
};

/** Stage 9: private spaces/folders/lists → override scopes with their members (permissions.md §7). */
export async function runPermissions(ctx: ImportContext) {
  if (!ctx.options.includePermissions) return;
  const plan = ctx.plan!;
  const objects: Array<{ type: 'space' | 'folder' | 'list'; cuId: string; name: string; private: boolean; members: Members; level?: string | null }> = [
    ...plan.spaces.map((s) => ({ type: 'space' as const, cuId: s.id, name: s.name, private: s.private, members: s.members })),
    ...plan.folders.map((f) => ({ type: 'folder' as const, cuId: f.cu.id, name: f.cu.name, private: !!f.cu.private, members: f.cu.members, level: f.cu.permission_level })),
    ...plan.lists.map((l) => ({ type: 'list' as const, cuId: l.cu.id, name: l.cu.name, private: !!l.cu.private, members: l.cu.members, level: l.cu.permission_level })),
  ];
  let done = 0;
  for (const o of objects) {
    const ext = `${o.type}:${o.cuId}`;
    const mapped = await ctx.lookup('share', ext);
    const id = await ctx.idOf(o.type, o.cuId);
    if (!o.private) {
      if (mapped && id && !ctx.dry) {
        // was private in an earlier import, public now
        await runTx(async (tx) => {
          await setSharing(tx, o.type, id, 'inherit', [], ctx.systemUserId);
          await ctx.unlink(tx, 'share', ext);
        });
        ctx.stat('sharing', 'updated');
        ctx.issue('info', 'sharing', o.cuId, `${o.type} "${o.name}" is no longer private in ClickUp; sharing reset to inherit`);
      }
      ctx.progress(++done, objects.length);
      continue;
    }
    ctx.stat('sharing', 'seen');
    let cuMembers = o.members ? memberIds(o.members) : null;
    if (!cuMembers && o.type === 'list') {
      try {
        cuMembers = (await ctx.api.getListMembers(o.cuId)).map((u) => u.id);
      } catch (err) {
        ctx.issue('warn', 'sharing', o.cuId, `Members of private list "${o.name}" could not be read: ${(err as Error).message}`);
      }
    }
    if (!cuMembers) {
      ctx.issue('warn', 'sharing', o.cuId, `Private ${o.type} "${o.name}": its members are not available through the ClickUp API; imported as private to admins only — share it manually`);
      cuMembers = [];
    }
    const entries: ShareEntryInput[] = [];
    for (const m of cuMembers) {
      const u = ctx.users.get(m);
      if (u) entries.push({ principalType: 'user', principalId: u, level: levelFor(o.level) });
      else ctx.issue('warn', 'sharing', o.cuId, `Private ${o.type} "${o.name}": member ${m} is not mapped and was not given access`);
    }
    if (ctx.dry || !id) {
      ctx.stat('sharing', mapped ? 'unchanged' : 'created');
      ctx.progress(++done, objects.length);
      continue;
    }
    await runTx(async (tx) => {
      const cur = await getSharing(tx, o.type, id);
      const own = cur.mode === 'override' ? cur.chain[0]?.entries ?? [] : null;
      if (own && same(own, entries)) {
        ctx.stat('sharing', 'unchanged');
      } else {
        await setSharing(tx, o.type, id, 'override', entries, ctx.systemUserId);
        ctx.stat('sharing', mapped ? 'updated' : 'created');
      }
      await ctx.link(tx, 'share', ext, id, null);
    });
    ctx.progress(++done, objects.length);
    await ctx.checkpoint();
  }
  ctx.issue('info', 'sharing', null, 'Tasks shared individually with guests or members in ClickUp are not detected by the API; re-share those tasks here');
  ctx.issue('info', 'sharing', null, 'ClickUp custom roles (Enterprise) are mapped to the nearest standard role; guest "can see time spent/estimated" toggles are not supported (guests see time fields on visible tasks)');
}
