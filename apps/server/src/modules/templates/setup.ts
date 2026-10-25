import { eq } from 'drizzle-orm';
import { templates, users } from '../../db/schema';
import { Forbidden, NotFound, Validation } from '../../lib/errors';
import { setListFromTemplateHandler } from '../hierarchy/routes';
import { applyListTemplate, type ListTemplatePayload } from './service';

/** POST /hierarchy/lists with templateId fills the new list (the route already checked create_child). */
export async function setup() {
  setListFromTemplateHandler(async (tx, list, templateId, actorId) => {
    const [actor] = await tx.select({ role: users.role }).from(users).where(eq(users.id, actorId));
    if (!actor || actor.role === 'guest') throw new Forbidden('Guests cannot use templates');
    const [t] = await tx.select().from(templates).where(eq(templates.id, templateId));
    if (!t) throw new NotFound('Template not found');
    if (t.kind !== 'list') throw new Validation('That is not a list template');
    await applyListTemplate(tx, list, t.payload as unknown as ListTemplatePayload, actorId);
  });
}
