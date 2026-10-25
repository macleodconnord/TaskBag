import { AsyncLocalStorage } from 'node:async_hooks';
import { db, type Tx } from '../db/client';
import { log } from './log';

type Store = { after: Array<() => unknown> };
const als = new AsyncLocalStorage<Store>();

/**
 * Run `fn` in a DB transaction. Callbacks registered with `afterCommit()` inside it
 * (events, ACL cache bumps) run only once the transaction has committed.
 */
export async function runTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const outer = als.getStore();
  if (outer) return db.transaction(fn); // nested: outer runTx owns the after-commit queue
  const store: Store = { after: [] };
  const result = await als.run(store, () => db.transaction(fn));
  for (const cb of store.after) {
    try {
      await cb();
    } catch (err) {
      log.error({ err }, 'afterCommit callback failed');
    }
  }
  return result;
}

/** Defer until the surrounding runTx commits; runs immediately outside a transaction. */
export function afterCommit(cb: () => unknown) {
  const store = als.getStore();
  if (store) store.after.push(cb);
  else void Promise.resolve().then(cb).catch((err) => log.error({ err }, 'afterCommit callback failed'));
}
