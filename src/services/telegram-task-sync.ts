import type { CrmRepository } from '../repositories/crm-repository';

export function observeTelegramTaskChanges(
  repository: Pick<CrmRepository, 'subscribeTaskChanges'>,
  isActive: () => boolean,
  currentSync: () => Promise<unknown> | null,
  sync: () => Promise<unknown>,
): () => void {
  // An observer can refresh before the provider has replaced an older repository.
  if (typeof repository.subscribeTaskChanges !== 'function') return () => {};
  let pending = false, draining = false, stopped = false;
  const active = () => !stopped && isActive();

  async function drain() {
    draining = true;
    try {
      while (pending && active()) {
        // An earlier sync may already have taken its outbox snapshot.
        let previous: Promise<unknown> | null;
        while (active() && (previous = currentSync())) await previous.catch(() => undefined);
        if (!active()) break;
        pending = false;
        await sync();
      }
    } catch {
      // The sync client persisted the backoff. Foreground maintenance will retry.
    } finally {
      pending = false;
      draining = false;
    }
  }

  const unsubscribe = repository.subscribeTaskChanges(() => {
    if (!active()) return;
    pending = true;
    if (!draining) void drain();
  });
  return () => { stopped = true; unsubscribe(); };
}
