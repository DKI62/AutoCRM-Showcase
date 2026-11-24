import type { CrmRepository } from '../repositories/crm-repository';
import { Store, type Connection } from './store';

export function createRepositorySession(
  open: () => Promise<Connection & { closeAsync(): Promise<void> }>,
  migrate: (db: Connection) => Promise<void>,
  uuid: () => string,
) {
  let opening: Promise<Store> | undefined;
  const repositories = new WeakMap<typeof CrmRepository, Promise<CrmRepository>>();

  return function repositoryFor(Repository: typeof CrmRepository): Promise<CrmRepository> {
    const cached = repositories.get(Repository);
    if (cached) return cached;
    opening ??= (async () => {
      const db = await open();
      try {
        await migrate(db);
        return new Store(db);
      } catch (error) {
        await db.closeAsync().catch(() => undefined);
        throw error;
      }
    })().catch(error => { opening = undefined; throw error; });

    const repository = opening.then(store => new Repository(store, uuid)).catch(error => {
      repositories.delete(Repository);
      throw error;
    });
    repositories.set(Repository, repository);
    return repository;
  };
}
