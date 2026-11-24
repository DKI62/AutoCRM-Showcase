import { assertManagedPath } from './image-rules';
import type { CrmRepository } from '../repositories/crm-repository';

/** Only explicitly journaled app copies are candidates. A failed DB read leaves everything intact. */
export async function recoverMediaCopies(paths: readonly string[], referenced: (path: string) => Promise<boolean>,
  remove: (path: string, committed: boolean) => void): Promise<void> {
  for (const path of paths) {
    try {
      assertManagedPath(path);
      remove(path, await referenced(path));
    } catch { /* Keep the marker for a later pass; never guess ownership. */ }
  }
}

export async function processMediaCleanup(repository: Pick<CrmRepository, 'cleanupFiles' | 'hasMediaPath' | 'confirmCleanup'>,
  discard: (file: { relative_path: string }) => void): Promise<number> {
  let pending = 0;
  for (const file of await repository.cleanupFiles()) {
    try {
      assertManagedPath(file.relative_path);
      if (!await repository.hasMediaPath(file.relative_path)) discard(file);
      await repository.confirmCleanup(file.relative_path);
    } catch { pending++; }
  }
  return pending;
}
