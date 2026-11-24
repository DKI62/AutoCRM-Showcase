import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Connection } from '../src/storage/store';

export async function nativeSqlite() {
  const child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-File', 'tests/native-sqlite.ps1'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let errors = '';
  child.stderr.on('data', chunk => { errors += String(chunk); });
  const reader = createInterface({ input: child.stdout });
  let resolveReady!: (version: string) => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const pending: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  child.on('error', error => { rejectReady(error); for (const job of pending.splice(0)) job.reject(error); });
  const exited = new Promise<void>(resolve => child.on('exit', code => {
    if (code !== 0) { const error = new Error(errors || `Native SQLite fixture exited: ${code}`); rejectReady(error); for (const job of pending.splice(0)) job.reject(error); }
    resolve();
  }));
  reader.on('line', line => {
    const result = JSON.parse(line) as { version?: string; value?: unknown; error?: string };
    if (result.version) { resolveReady(result.version); return; }
    const job = pending.shift(); if (!job) return;
    if (result.error) job.reject(new Error(result.error)); else job.resolve(result.value);
  });
  async function request<T>(op: string, sql: string, args: unknown[] = []): Promise<T> {
    return new Promise<T>((resolve, reject) => { pending.push({ resolve: value => resolve(value as T), reject }); child.stdin.write(JSON.stringify({ op, sql, args }) + '\n'); });
  }
  const db: Connection = {
    execAsync: sql => request<void>('exec', sql),
    runAsync: (sql: string, ...args: unknown[]) => request('run', sql, args),
    getAllAsync: <T>(sql: string, ...args: unknown[]) => request<T[]>('all', sql, args),
    getFirstAsync: async <T>(sql: string, ...args: unknown[]) => (await request<T[]>('all', sql, args))[0] ?? null,
    async withTransactionAsync(work) {
      await request('exec', 'BEGIN');
      try { await work(); await request('exec', 'COMMIT'); } catch (error) { await request('exec', 'ROLLBACK'); throw error; }
    },
  };
  return { db, version: await ready, close: async () => { child.stdin.end(); await exited; reader.close(); } };
}
