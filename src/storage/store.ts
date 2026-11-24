import type { SQLiteDatabase } from 'expo-sqlite';

export type Connection = Pick<SQLiteDatabase,
  'execAsync' | 'runAsync' | 'getFirstAsync' | 'getAllAsync' | 'withTransactionAsync'>;

export class Store {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly db: Connection) {}

  // All reads and writes share this queue: no unrelated query can enter a transaction.
  read<T>(operation: (db: Connection) => Promise<T>): Promise<T> {
    const result = this.queue.then(() => operation(this.db));
    this.queue = result.catch(() => undefined);
    return result;
  }

  write<T>(operation: (db: Connection) => Promise<T>): Promise<T> {
    return this.read(async db => {
      let result!: T;
      await db.withTransactionAsync(async () => { result = await operation(db); });
      return result;
    });
  }
}
