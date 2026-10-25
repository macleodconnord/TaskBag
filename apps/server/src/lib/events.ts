import { randomUUID } from 'node:crypto';
import { log } from './log';
import { afterCommit } from './tx';

/**
 * In-process domain events, delivered after the emitting transaction commits.
 * (Simplified from the outbox design: a crash between commit and delivery can drop
 * a notification, which is acceptable for a ~10 user install.)
 */
export interface DomainEvents {
  'task.created': { taskId: string; actorId: string | null };
  'task.updated': { taskId: string; actorId: string | null; changes: Record<string, { from: unknown; to: unknown }> };
  'task.deleted': { taskId: string; actorId: string | null; listId: string; name: string };
  'task.assigned': { taskId: string; actorId: string | null; userIds: string[] };
  'comment.created': { commentId: string; taskId: string | null; docId: string | null; actorId: string; mentionedUserIds: string[] };
  'doc.mentioned': { docId: string; actorId: string; mentionedUserIds: string[] };
  'external.event': { source: 'gitea' | 'ninjaone'; event: string; taskId: string; data?: Record<string, unknown> };
}
export type EventName = keyof DomainEvents;
export type EventEnvelope<K extends EventName = EventName> = { id: string; type: K; at: string; data: DomainEvents[K] };

type Handler<K extends EventName> = (e: EventEnvelope<K>) => unknown | Promise<unknown>;
const handlers = new Map<EventName | '*', Array<Handler<any>>>();

export function on<K extends EventName>(type: K | '*', h: Handler<K>) {
  const list = handlers.get(type) ?? [];
  list.push(h);
  handlers.set(type, list);
}

export function emit<K extends EventName>(type: K, data: DomainEvents[K]) {
  const env: EventEnvelope<K> = { id: randomUUID(), type, at: new Date().toISOString(), data };
  afterCommit(() => dispatch(env));
}

async function dispatch(e: EventEnvelope) {
  for (const h of [...(handlers.get(e.type) ?? []), ...(handlers.get('*') ?? [])]) {
    try {
      await h(e);
    } catch (err) {
      log.error({ err, event: e.type }, 'event handler failed');
    }
  }
}
