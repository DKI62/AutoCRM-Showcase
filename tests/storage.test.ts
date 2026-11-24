import { demoBackup } from '../demo/fixture';
import type { Environment } from '../server/telegram/worker';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import initSqlJs, { type BindParams, type Database, type SqlValue } from 'sql.js';
import { CrmRepository } from '../src/repositories/crm-repository';
import { createCommitGate } from '../src/services/commit-gate';
import { createReminderReconciler } from '../src/services/reminder-reconciler';
import { processMediaCleanup, recoverMediaCopies } from '../src/services/media-recovery';
import type { RemoteTask } from '../src/services/telegram-protocol';
import { observeTelegramTaskChanges } from '../src/services/telegram-task-sync';
import { calendarDaysAfter } from '../src/domain/vehicle-review';
import { readAppearance, saveAppearance, type AppearanceMode } from '../src/domain/appearance';
import { migrate, migrations } from '../src/storage/migrations';
import { createRepositorySession } from '../src/storage/repository-session';
import { Store, type Connection } from '../src/storage/store';

const sqlite = initSqlJs();

// Real SQLite WASM engine; native expo-sqlite must also be verified on Android.
function connection(db: Database): Connection {
  function bind(args: unknown[]): BindParams {
    return args.length === 1 && typeof args[0] === 'object' ? args[0] as BindParams : args as SqlValue[];
  }
  function rows<T>(sql: string, args: unknown[]): T[] {
    const statement = db.prepare(sql);
    try {
      statement.bind(bind(args));
      const result: T[] = [];
      while (statement.step()) result.push(statement.getAsObject() as T);
      return result;
    } finally { statement.free(); }
  }
  return {
    async execAsync(sql) { db.exec(sql); },
    async runAsync(sql: string, ...args: unknown[]) {
      db.run(sql, bind(args));
      return { changes: db.getRowsModified(), lastInsertRowId: Number(db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0]) };
    },
    async getFirstAsync<T>(sql: string, ...args: unknown[]): Promise<T | null> { return rows<T>(sql, args)[0] ?? null; },
    async getAllAsync<T>(sql: string, ...args: unknown[]): Promise<T[]> { return rows<T>(sql, args); },
    async withTransactionAsync(work) {
      db.exec('BEGIN');
      try { await work(); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}

async function fixture() {
  const SQL = await sqlite;
  const db = new SQL.Database();
  const c = connection(db);
  await migrate(c);
  const store = new Store(c);
  return { SQL, db, c, store, repo: new CrmRepository(store, randomUUID) };
}

test('appearance persists across SQLite reopen and leaves existing preferences intact', async () => {
  const { SQL, db, repo } = await fixture();
  try {
    assert.equal(await readAppearance(repo), 'dark');
    await repo.setSetting('notification_sound', 'off');
    for (const mode of ['light', 'system', 'dark'] satisfies AppearanceMode[]) {
      await saveAppearance(repo, mode);
      const reopened = new SQL.Database(db.export());
      try {
        const repository = new CrmRepository(new Store(connection(reopened)), randomUUID);
        assert.equal(await readAppearance(repository), mode);
        assert.equal(await repository.getSetting('notification_sound'), 'off');
      } finally { reopened.close(); }
    }
    await repo.setSetting('appearance_mode', 'invalid');
    assert.equal(await readAppearance(repo), 'dark');
  } finally { db.close(); }
});

test('task editor gate suppresses triple taps, retries SQLite failure, and releases navigation before Android settles', async () => {
  const { db, c, repo } = await fixture();
  try {
    const car = await repo.createVehicle({ make: '', model: '', title: 'Лот', note: '' }, null);
    const id = randomUUID(), gate = createCommitGate();
    const input = { vehicle_id: car, title: 'Звонок', description: 'После обеда', due_at: Date.now() + 60_000, status: 'pending' as const, repeat_mode: 'none' as const };
    const commit = () => repo.saveTask(input, id, undefined, true);
    await c.execAsync("CREATE TRIGGER fail_task BEFORE INSERT ON lot_tasks BEGIN SELECT RAISE(ABORT,'disk write failed'); END");
    await assert.rejects(gate.run(commit), /disk write failed/);
    assert.equal(gate.phase(), 'idle');
    assert.equal(await repo.getTask(id), null);
    assert.equal((await repo.pendingReminders()).length, 0);
    await c.execAsync('DROP TRIGGER fail_task');
    let calls = 0;
    const first = gate.run(commit, async () => { calls++; await new Promise<void>(() => {}); });
    assert.equal(gate.phase(), 'saving');
    assert.deepEqual(await Promise.all([gate.run(commit), gate.run(commit)]), [null, null]);
    assert.deepEqual(await first, { value: id });
    assert.equal(calls, 1);
    assert.equal(gate.phase(), 'committed');
    assert.equal(await commit(), id); // A retry with the same ID is safe outside this form lifetime.
    const saved = (await repo.getTask(id))!;
    const reminder = (await repo.pendingReminders())[0]!;
    await repo.saveTask(input, id, saved.updated_at);
    assert.equal((await repo.getTask(id))?.updated_at, saved.updated_at);
    assert.equal((await repo.pendingReminders())[0]?.provider_id, reminder.provider_id);
    assert.equal((await repo.getTask(id))?.description, input.description);
    assert.equal((await repo.getTask(id))?.due_at, input.due_at);
    assert.equal((await repo.listTasks(car)).length, 1);
    assert.equal((await repo.getVehicle(car))?.events.filter(event => event.kind === 'task').length, 1);
  } finally { db.close(); }
});

test('reminder queue retries denial, recovers Android acceptance after restart, and cancels before rescheduling', async () => {
  const { db, repo } = await fixture();
  try {
    const car = await repo.createVehicle({ make: '', model: '', title: 'Лот', note: '' }, null);
    const input = { vehicle_id: car, title: 'Звонок', description: 'В рабочее время', due_at: Date.now() + 60_000, status: 'pending' as const, repeat_mode: 'daily' as const };
    const id = await repo.saveTask(input), old = (await repo.pendingReminders())[0]!.provider_id;
    await repo.saveTask({ ...input, title: 'Просрочено', due_at: Date.now() - 60_000, repeat_mode: 'none' });
    const native = new Map<string, number>(), trace: string[] = [];
    let mode: 'denied' | 'crash' | 'ok' = 'denied';
    const api = {
      list: async () => [...native.keys()],
      cancel: async (key: string) => { trace.push('cancel:' + key); native.delete(key); },
      schedule: async ({ id, at }: { id: string; at: Date }) => {
        trace.push('schedule:' + id);
        if (mode === 'denied') throw new Error('permission denied');
        native.set(id, at.getTime());
        if (mode === 'crash') throw new Error('bridge lost result after Android committed');
        return id;
      },
    };
    const reconcile = createReminderReconciler(api);
    await reconcile(repo);
    assert.equal((await repo.getTask(id))?.status, 'pending');
    assert.equal((await repo.pendingReminders()).find(r => r.provider_id === old)?.error, 'permission denied');
    mode = 'crash';
    await reconcile(repo);
    assert.equal(native.get(old), input.due_at);
    mode = 'ok'; trace.length = 0;
    const reopened = createReminderReconciler(api);
    await Promise.all([reopened(repo), reopened(repo), reopened(repo)]);
    assert.deepEqual(trace, []);
    assert.equal((await repo.pendingReminders()).find(r => r.provider_id === old)?.state, 'scheduled');
    const newDue = input.due_at + 120_000;
    await repo.saveTask({ ...input, due_at: newDue }, id);
    const next = (await repo.pendingReminders()).find(r => r.task_id === id)!.provider_id;
    await reopened(repo);
    assert.deepEqual(trace, ['cancel:' + old, 'schedule:' + next]);
    assert.deepEqual([...native], [[next, newDue]]);
    await repo.changeStage(car, 'completed', 'declined'); await reopened(repo);
    assert.equal(native.size, 0);
    await assert.rejects(repo.completeTask(id), /из архива/);
    await repo.changeStage(car, 'cold'); await reopened(repo);
    assert.equal(native.size, 1);
    await Promise.all([repo.completeTask(id), repo.completeTask(id), repo.completeTask(id)]);
    await reopened(repo);
    const repeat = (await repo.listTasks(car)).find(t => t.id !== id && t.due_at > newDue)!;
    assert.equal(repeat.description, input.description);
    assert.equal((await repo.listTasks(car)).length, 3);
    assert.deepEqual([...native.values()], [repeat.due_at]);
  } finally { db.close(); }
});

test('an edit during native scheduling never leaves two active alarms', async () => {
  const { db, repo } = await fixture();
  try {
    const car = await repo.createVehicle({ make: '', model: '', title: 'Лот', note: '' }, null);
    const input = { vehicle_id: car, title: 'Звонок', due_at: Date.now() + 60_000, status: 'pending' as const, repeat_mode: 'none' as const };
    const id = await repo.saveTask(input);
    const native = new Set<string>();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    const reconcile = createReminderReconciler({
      list: async () => [...native],
      cancel: async key => { native.delete(key); },
      schedule: async ({ id: key }) => {
        if (first) { first = false; enter(); await resume; }
        assert.equal(native.size, 0);
        native.add(key); return key;
      },
    });
    const running = reconcile(repo);
    await entered;
    await repo.saveTask({ ...input, due_at: input.due_at + 120_000 }, id);
    const second = reconcile(repo);
    release();
    await Promise.all([running, second]);
    assert.deepEqual([...native], [(await repo.pendingReminders())[0]!.provider_id]);
    assert.deepEqual(await repo.cancellations(), []);
  } finally { db.close(); }
});

test('migrations, vehicle, note and attachment survive disk export, reopen and repeated migrations', async () => {
  const { SQL, db, repo } = await fixture();
  const filename = `${randomUUID()}.png`;
  const id = await repo.createVehicle({ make: ' Toyota ', model: 'Camry', title: 'Лот', note: '450 если коробка живая', sourceUrl: 'https://example.org/car' },
    { relative_path: filename, mime_type: 'image/png' });
  const attachment = (await repo.getVehicle(id))?.attachments[0];
  assert.ok(attachment);
  await repo.updateAttachmentCaption(attachment.id, 'Объявление продавца');
  const folder = mkdtempSync(join(tmpdir(), 'autocrm-s0-'));
  const file = join(folder, 'fixture.db');
  let reopened: Database | undefined;
  try {
    writeFileSync(file, db.export()); db.close();
    reopened = new SQL.Database(readFileSync(file));
    const c = connection(reopened);
    await migrate(c); await migrate(c);
    const recovered = await new CrmRepository(new Store(c), randomUUID).getVehicle(id);
    assert.equal(recovered?.vehicle.make, 'Toyota');
    assert.equal(recovered?.notes[0]?.body, '450 если коробка живая');
    assert.equal(recovered?.attachments[0]?.relative_path, filename);
    assert.equal(recovered?.attachments[0]?.caption, 'Объявление продавца');
    assert.equal((await c.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version, migrations.length);
    assert.equal((await c.getFirstAsync<{ foreign_keys: number }>('PRAGMA foreign_keys'))?.foreign_keys, 1);
  } finally { reopened?.close(); unlinkSync(file); rmdirSync(folder); }
});

test('failed migration rolls back schema/version and preserves existing records; newer DB is rejected', async () => {
  const { db, c, repo } = await fixture();
  try {
    const id = await repo.createVehicle({ make: 'A', model: 'B', note: 'Keep me' }, null);
    await assert.rejects(migrate(c, [...migrations, 'CREATE TABLE partial (id TEXT); INVALID SQL;']));
    assert.equal((await repo.getVehicle(id))?.notes[0]?.body, 'Keep me');
    assert.equal(await c.getFirstAsync("SELECT name FROM sqlite_master WHERE name='partial'"), null);
    assert.equal((await c.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version, migrations.length);
    await c.execAsync('PRAGMA user_version = 99');
    await assert.rejects(migrate(c), /более новой/);
    assert.ok(await repo.getVehicle(id));
  } finally { db.close(); }
});

test('related creation is atomic; foreign keys and failed updates protect saved data', async () => {
  const { db, c, repo } = await fixture();
  try {
    await assert.rejects(repo.createVehicle({ make: 'A', model: 'B', note: 'Must roll back' }, { relative_path: '../bad.png', mime_type: 'image/png' }));
    assert.equal((await repo.listVehicles()).length, 0);
    assert.equal((await c.getAllAsync('SELECT * FROM notes')).length, 0);
    const id = await repo.createVehicle({ make: 'A', model: 'B', note: 'original' }, null);
    assert.throws(() => repo.updateVehicle(id, { make: '', model: 'B' }));
    await repo.updateVehicle(id, { make: 'Updated', model: 'B' });
    await c.execAsync("CREATE TRIGGER fail_update BEFORE UPDATE ON lots BEGIN SELECT RAISE(ABORT, 'disk failure fixture'); END;");
    await assert.rejects(repo.updateVehicle(id, { make: 'Changed', model: 'B' }));
    assert.equal((await repo.getVehicle(id))?.vehicle.make, 'Updated');
    await assert.rejects(repo.saveNote('missing-id', 'orphan'), /FOREIGN KEY/);
    assert.equal((await repo.getVehicle(id))?.notes[0]?.body, 'original');
  } finally { db.close(); }
});

test('notes and tasks update independently; receiving a notification never completes tasks or changes vehicle status', async () => {
  const { db, repo } = await fixture();
  try {
    const id = await repo.createVehicle({ make: 'A', model: 'B', note: '' }, null);
    const noteId = await repo.saveNote(id, 'first');
    await repo.saveNote(id, 'revised', noteId);
    const task = { vehicle_id: id, title: 'Осмотр', due_at: Date.now() + 3600000, status: 'pending' as const, repeat_mode: 'none' as const };
    const taskId = await repo.saveTask(task);
    await repo.saveTask({ ...task, title: 'Перезвонить' });
    await repo.recordNotification('test-provider', randomUUID(), 'received');
    assert.equal((await repo.listTasks(id)).length, 2);
    assert.ok((await repo.listTasks(id)).every(t => t.status === 'pending'));
    assert.equal((await repo.getVehicle(id))?.vehicle.status, 'cold');
    await repo.saveTask({ ...task, status: 'done' }, taskId);
    assert.equal((await repo.listTasks(id)).filter(t => t.status === 'done').length, 1);
    assert.equal((await repo.getVehicle(id))?.notes[0]?.body, 'revised');
    const other = await repo.createVehicle({ make: 'C', model: 'D', note: '' }, null);
    await assert.rejects(repo.saveNote(other, 'hijack', noteId));
    await assert.rejects(repo.saveTask({ ...task, vehicle_id: other }, taskId));
  } finally { db.close(); }
});

test('queries bind user text and paginate; corporate and completed cars do not mix into regular list', async () => {
  const { db, c, repo } = await fixture();
  try {
    const literal = "Car'); DROP TABLE vehicles; --";
    const first = await repo.createVehicle({ make: literal, model: 'B', note: '' }, null);
    const second = await repo.createVehicle({ make: 'C', model: 'D', note: '' }, null);
    assert.equal((await repo.getVehicle(first))?.vehicle.make, literal);
    assert.equal((await repo.listVehicles(0, 1)).length, 1);
    assert.equal((await repo.listVehicles(1, 1)).length, 1);
    await c.runAsync("UPDATE lots SET lot_type='corporate' WHERE id=?", second);
    assert.deepEqual((await repo.listVehicles()).map(v => v.id), [first]);
    await c.runAsync("UPDATE lots SET status='completed',completion_reason='bought' WHERE id=?", first);
    assert.equal((await repo.listVehicles()).length, 0);
    assert.throws(() => repo.listVehicles(-1));
    await assert.rejects(c.runAsync("UPDATE lots SET completion_reason=NULL WHERE id=?", first));
  } finally { db.close(); }
});

test('queue isolates concurrent readers from rollback and remains usable after failure', async () => {
  const { db, store } = await fixture();
  try {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const write = store.write(async c => {
      await c.runAsync("INSERT INTO vehicles (id,make,model,created_at,updated_at) VALUES ('rollback','A','B',1,1)");
      entered(); await gate; throw new Error('rollback');
    });
    const rejected = assert.rejects(write, /rollback/);
    await started;
    const read = store.read(c => c.getFirstAsync("SELECT * FROM vehicles WHERE id='rollback'"));
    release(); await rejected;
    assert.equal(await read, null);
    assert.equal((await store.read(c => c.getAllAsync('SELECT * FROM vehicles'))).length, 0);
  } finally { db.close(); }
});


test('S0 migration preserves every UUID, child and legacy table without dropping old data', async () => {
  const SQL = await sqlite; const db = new SQL.Database(); const c = connection(db);
  try {
    await migrate(c, [migrations[0]!]);
    const id = randomUUID(), note = randomUUID(), media = randomUUID(), task = randomUUID();
    await c.runAsync('INSERT INTO vehicles(id,make,model,created_at,updated_at) VALUES(?,?,?,?,?)', id, 'Старая', 'Модель', 1, 2);
    await c.runAsync('INSERT INTO notes VALUES(?,?,?,?,?)', note, id, 'Договорённость', 1, 2);
    await c.runAsync('INSERT INTO attachments VALUES(?,?,?,?,?,?,?)', media, id, `${randomUUID()}.png`, 'image/png', 'Кузов', 1, 2);
    await c.runAsync('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)', task, id, 'Осмотр', 1234, 'pending', 'daily', 1, 2);
    await migrate(c); await migrate(c);
    const repo = new CrmRepository(new Store(c), randomUUID); const restored = await repo.getVehicle(id);
    assert.equal(restored?.notes[0]?.id, note); assert.equal(restored?.attachments[0]?.id, media);
    assert.equal((await repo.listTasks(id))[0]?.id, task);
    assert.ok(await c.getFirstAsync('SELECT id FROM vehicles WHERE id=?', id));
    assert.equal((await repo.listVehicles(0, 50, { query: 'договорённость' }))[0]?.id, id);
    assert.deepEqual(await c.getAllAsync('PRAGMA foreign_key_check'), []);
  } finally { db.close(); }
});

test('title-only/phone-only lots, corporate filters, Cyrillic search, stage gates and archive preserve media', async () => {
  const { db, repo } = await fixture();
  try {
    const id = await repo.createVehicle({ make: '', model: '', title: 'Проверка', note: '', lot_type: 'corporate' }, null);
    const phone = await repo.createVehicle({ make: '', model: '', phone: '+0 000 000', note: '' }, null);
    assert.equal((await repo.getVehicle(phone))?.vehicle.phone, '+0 000 000');
    assert.equal((await repo.listVehicles(0, 50, { query: '000-0000' }))[0]?.id, phone);
    await repo.saveNote(id, 'Осмотрена подвеска');
    assert.equal((await repo.listVehicles(0, 50, { query: 'ПОДВЕСКА', lotType: 'corporate' }))[0]?.id, id);
    await assert.rejects(repo.changeStage(id, 'in_progress'), /оценка выкупа/);
    await repo.updateVehicle(id, { make: '', model: '', title: 'Проверка', lot_type: 'corporate', buyout_price: '450 если коробка живая', market_price: '500–550' });
    await repo.saveTask({ vehicle_id: id, title: 'Перезвонить', due_at: Date.now() + 3600000, status: 'pending', repeat_mode: 'none' });
    await repo.changeStage(id, 'in_progress');
    await repo.addMedia(id, [{ relative_path: `${randomUUID()}.mp4`, mime_type: 'video/mp4', byte_size: 200e6 }, { relative_path: `${randomUUID()}.png`, mime_type: 'image/png' }]);
    const photo = (await repo.getVehicle(id))!.attachments.find(m => m.mime_type.startsWith('image/'))!;
    await repo.setCover(id, photo.id);
    await assert.rejects(repo.setCover(phone, photo.id));
    await repo.changeStage(id, 'completed', 'bought');
    assert.equal((await repo.listVehicles(0, 50, { archive: true, reason: 'bought' }))[0]?.id, id);
    assert.equal((await repo.pendingReminders()).length, 0);
    await repo.changeStage(id, 'cold');
    assert.equal((await repo.getVehicle(id))?.attachments.length, 2);
    assert.equal((await repo.pendingReminders()).length, 1);
    await repo.removeMedia(id, photo.id);
    assert.equal((await repo.getVehicle(id))?.vehicle.cover_id, null);
    assert.deepEqual(await repo.cleanupFiles(), [{ relative_path: photo.relative_path }]);
  } finally { db.close(); }
});

test('rescheduling queues cancellation, completion is idempotent and daily recurrence keeps completed history', async () => {
  const { db, repo } = await fixture();
  try {
    const car = await repo.createVehicle({ make: '', model: '', title: 'Лот', note: '' }, null);
    const task = { vehicle_id: car, title: 'Звонок', due_at: Date.now() + 60000, status: 'pending' as const, repeat_mode: 'daily' as const };
    const id = await repo.saveTask(task);
    const previous = (await repo.pendingReminders())[0]!;
    await repo.saveTask({ ...task, due_at: task.due_at + 1000 }, id);
    assert.equal((await repo.cancellations())[0]?.provider_id, previous.provider_id);
    assert.notEqual((await repo.pendingReminders())[0]?.provider_id, previous.provider_id);
    await repo.recordNotification('android', previous.provider_id, 'received');
    assert.equal((await repo.listTasks(car))[0]?.status, 'pending');
    await repo.completeTask(id); await repo.completeTask(id);
    const rows = await repo.listTasks(car);
    assert.equal(rows.filter(t => t.status === 'done').length, 1);
    assert.equal(rows.filter(t => t.status === 'pending').length, 1);
    assert.ok(rows.find(t => t.status === 'pending')!.due_at > task.due_at);
    assert.equal((await repo.pendingReminders()).length, 1);
  } finally { db.close(); }
});

test('backup manifest rejects injected columns, traversal, missing files and preserves full merge atomically', async () => {
  const { validateManifest } = await import('../src/services/backup-manifest');
  const source = await fixture(), target = await fixture();
  try {
    const path = `${randomUUID()}.mp4`;
    const photo = `${randomUUID()}.png`;
    const id = await source.repo.createVehicle({ make: '', model: '', title: 'Копия', note: 'История', buyout_price: '1,95 млн с торгом' }, [
      { relative_path: path, mime_type: 'video/mp4', byte_size: 30000000 }, { relative_path: photo, mime_type: 'image/png', byte_size: 64000 },
    ]);
    const cover = (await source.repo.getVehicle(id))!.attachments.find(item => item.relative_path === photo)!;
    await source.repo.setCover(id, cover.id); await source.repo.updateAttachmentCaption(cover.id, 'Дефект');
    const taskId = await source.repo.saveTask({ vehicle_id: id, title: 'Осмотр', description: 'Проверить пороги', due_at: Date.now() + 60_000, status: 'pending', repeat_mode: 'weekly' });
    const manifest = { format: 'auto-crm-folder', version: 2, createdAt: Date.now(), tables: await source.repo.snapshot(), preferences: {
      notification_sound: 'off' as const, notification_vibration: 'off' as const,
    }, files: [
      { path, size: 30000000, md5: 'a'.repeat(32) }, { path: photo, size: 64000, md5: 'b'.repeat(32) },
    ] };
    validateManifest(manifest);
    const missing = structuredClone(manifest); missing.files = []; assert.throws(() => validateManifest(missing));
    const injected = structuredClone(manifest); injected.tables.lots![0]!['id); DROP TABLE lots; --'] = 'x'; assert.throws(() => validateManifest(injected));
    const traversal = structuredClone(manifest); traversal.files[0]!.path = '../secret'; assert.throws(() => validateManifest(traversal));
    const mapped = `${randomUUID()}.mp4`;
    const mappedPhoto = `${randomUUID()}.png`;
    const paths = new Map([[path, mapped], [photo, mappedPhoto]]);
    await assert.rejects(target.repo.restoreRows(manifest.tables, new Map([[path, mapped]])));
    assert.equal((await target.repo.snapshot()).lots!.length, 0);
    await target.repo.setSetting('notification_vibration', 'on');
    assert.equal(await target.repo.restoreRows(manifest.tables, paths, manifest.preferences), 1);
    assert.equal(await target.repo.getSetting('notification_sound'), 'off');
    assert.equal(await target.repo.getSetting('notification_vibration'), 'on');
    assert.throws(() => validateManifest({ ...manifest, preferences: { telegram_enabled: 'on' } }));
    assert.throws(() => validateManifest({ ...manifest, version: 3 }));
    const restored = (await target.repo.getVehicle(id))!;
    assert.equal(restored.vehicle.cover_id, cover.id);
    assert.equal(restored.vehicle.buyout_price, '1,95 млн с торгом');
    assert.equal(restored.attachments.find(item => item.mime_type === 'video/mp4')?.relative_path, mapped);
    assert.deepEqual(restored.attachments.find(item => item.id === cover.id), { ...cover, relative_path: mappedPhoto, caption: 'Дефект', updated_at: restored.attachments.find(item => item.id === cover.id)!.updated_at });
    assert.deepEqual(restored.notes, (await source.repo.getVehicle(id))!.notes);
    assert.deepEqual(restored.events, (await source.repo.getVehicle(id))!.events);
    assert.deepEqual(await target.repo.getTask(taskId), await source.repo.getTask(taskId));
    await target.repo.saveNote(id, 'Локальное изменение');
    assert.equal(await target.repo.restoreRows(manifest.tables, paths), 0);
    assert.equal((await target.repo.getVehicle(id))?.notes.length, 2);
    const legacy = { ...structuredClone(manifest), version: 1 };
    delete legacy.tables.lot_tasks![0]!.description;
    await source.repo.changeStage(id, 'completed', 'bought');
    legacy.tables.lots![0] = (await source.repo.snapshot()).lots![0]!;
    delete legacy.tables.lots![0]!['archived_at'];
    validateManifest(legacy);
    const old = await fixture();
    try {
      assert.equal(await old.repo.restoreRows(legacy.tables, paths), 1);
      assert.equal((await old.repo.getTask(taskId))?.description, '');
      assert.equal((await old.repo.getTask(taskId))?.vehicle_status, 'completed');
      assert.equal((await old.repo.pendingReminders()).length, 0);
      assert.deepEqual((await old.repo.listVehicles(0, 20, { archive: true })).map(item => item.id), [id]);
    } finally { old.db.close(); }
  } finally { source.db.close(); target.db.close(); }
});

test('Telegram server: private pairing, scoped auth, minimal payload, callbacks and durable confirmed actions', async () => {
  const { handleRequest, sendDue } = await import('../server/telegram/worker');
  type Statement = import('../server/telegram/worker').Statement;
  type ServerDatabase = import('../server/telegram/worker').ServerDatabase;
  const { minimalTask, quietNow } = await import('../server/telegram/protocol');
  const SQL = await sqlite; const db = new SQL.Database(); const c = connection(db);
  db.exec('PRAGMA foreign_keys=ON');
  const migrationDir = 'server/telegram/migrations';
  const files = readdirSync(migrationDir).sort();
  assert.equal(readFileSync(join(migrationDir, files[0]!), 'utf8'), readFileSync('server/telegram/schema.sql', 'utf8'));
  for (const file of files) db.exec(readFileSync(join(migrationDir, file), 'utf8'));
  function prepare(sql: string, values: (string | number | null)[] = []): Statement {
    return { bind: (...args) => prepare(sql, args), first: <T>() => c.getFirstAsync<T>(sql, ...values),
      all: async <T>() => ({ results: await c.getAllAsync<T>(sql, ...values) }), run: async () => ({ meta: { changes: (await c.runAsync(sql, ...values)).changes } }) };
  }
  const store: ServerDatabase = { prepare, batch: async statements => {
    const results: Awaited<ReturnType<Statement['run']>>[] = [];
    await c.withTransactionAsync(async () => { for (const statement of statements) results.push(await statement.run()); });
    return results;
  } };
  const env: Environment = { DB: store, FIXTURE_BOT_NAME: 'fixture_bot', FIXTURE_WEBHOOK_KEY: 'fixture-secret', FIXTURE_PAIRING_PEPPER: 'fixture-pepper' };
  const sent: Record<string, unknown>[] = [];
  let failNextSend = false;
  let redirectNextSend = false;
  let pauseNextSend: (() => Promise<void>) | undefined;
  env.telegramFixture = async (url, init) => {
    assert.equal(init?.redirect, 'manual');
    const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push(data);
    if (redirectNextSend && String(url).endsWith('/sendMessage')) {
      redirectNextSend = false;
      return new Response(null, { status: 302, headers: { Location: 'https://redirect.invalid/' } });
    }
    if (failNextSend && String(url).endsWith('/sendMessage')) {
      failNextSend = false;
      return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 120 } }, { status: 429 });
    }
    if (pauseNextSend && String(url).endsWith('/sendMessage')) {
      const pause = pauseNextSend;
      pauseNextSend = undefined;
      await pause();
    }
    return Response.json({ ok: true, result: { message_id: sent.length } });
  };
  try {
    const pair = await handleRequest(new Request('https://fixture.invalid/v1/pair', { method: 'POST', body: JSON.stringify({ pairingVersion: 2 }) }), env);
    const result = await pair.json() as { deviceToken: string; bindUrl: string };
    assert.equal(pair.status, 200);
    const headers = { Authorization: `Bearer ${result.deviceToken}`, 'Content-Type': 'application/json' };
    const code = new URL(result.bindUrl).searchParams.get('start')!;
    const webhook = (data: unknown, secret = env.FIXTURE_WEBHOOK_KEY) => handleRequest(new Request('https://fixture.invalid/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(data) }), env);
    assert.equal((await webhook({ update_id: 1 }, 'bad')).status, 401);
    const privateChat = { id: 42, type: 'private' };
    const sender = { id: 42 };
    const commandUpdate = (update_id: number, text: string, chat = privateChat) => ({
      update_id,
      message: { message_id: update_id, date: 1794441600, text, chat, from: { ...sender, is_bot: false, first_name: 'Fixture' },
        entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] },
    });
    const onboarding = commandUpdate(101, '/start');
    failNextSend = true;
    assert.equal((await webhook(onboarding)).status, 503);
    assert.equal(await c.getFirstAsync('SELECT id FROM webhook_updates WHERE id=101'), null);
    assert.equal((await webhook(onboarding)).status, 200);
    assert.match(String(sent.at(-1)?.text), /Настройки → Telegram/);
    assert.equal((await webhook(onboarding)).status, 200);
    assert.equal(sent.length, 2);
    assert.ok(await c.getFirstAsync('SELECT id FROM webhook_updates WHERE id=101'));
    const redirected = commandUpdate(110, '/help');
    redirectNextSend = true;
    assert.equal((await webhook(redirected)).status, 503);
    assert.equal(await c.getFirstAsync('SELECT id FROM webhook_updates WHERE id=110'), null);
    assert.equal((await webhook(redirected)).status, 200);
    for (const [id, text] of [[102, '/help@fixture_bot'], [103, '/status'], [104, '/tasks']] as const) {
      assert.equal((await webhook(commandUpdate(id, text))).status, 200);
      assert.match(String(sent.at(-1)?.text), /Настройки → Telegram/);
    }
    const beforeIgnored = sent.length;
    assert.equal((await webhook(commandUpdate(105, '/start@another_bot'))).status, 200);
    assert.equal((await webhook(commandUpdate(106, '/start', { id: -42, type: 'group' }))).status, 200);
    assert.equal(sent.length, beforeIgnored);
    failNextSend = true;
    assert.equal((await webhook(commandUpdate(1, `/start ${code}`))).status, 503);
    const deviceStatus = () => handleRequest(new Request('https://fixture.invalid/v1/device', { headers }), env).then(response => response.json());
    const pendingAfterBotFailure = await deviceStatus() as { linked: boolean; candidate: { requestId: string } };
    assert.equal(pendingAfterBotFailure.linked, false);
    await webhook({ update_id: 1, message: { text: `/start ${code}`, chat: privateChat, from: sender } });
    const proof = /Код подтверждения Auto CRM: ([a-f0-9]{12})/.exec(String(sent.at(-1)?.text))?.[1];
    assert.ok(proof);
    assert.deepEqual(await deviceStatus(), pendingAfterBotFailure);
    const confirm = () => handleRequest(new Request('https://fixture.invalid/v1/device/pairing', { method: 'POST', headers,
      body: JSON.stringify({ requestId: pendingAfterBotFailure.candidate.requestId, approve: true, code: proof }) }), env);
    assert.equal((await confirm()).status, 200);
    assert.deepEqual(await (await confirm()).json(), { linked: true });
    assert.equal((await webhook(commandUpdate(107, '/help'))).status, 200);
    assert.match(String(sent.at(-1)?.text), /ближайшие/);
    const linkedStatus = commandUpdate(108, '/status');
    failNextSend = true;
    assert.equal((await webhook(linkedStatus)).status, 503);
    assert.equal(await c.getFirstAsync('SELECT id FROM webhook_updates WHERE id=108'), null);
    assert.equal((await webhook(linkedStatus)).status, 200);
    assert.match(String(sent.at(-1)?.text), /Устройство привязано/);
    let releaseReply!: () => void, sendingReply!: () => void;
    const waitingReply = new Promise<void>(resolve => { releaseReply = resolve; });
    const replyStarted = new Promise<void>(resolve => { sendingReply = resolve; });
    pauseNextSend = () => { sendingReply(); return waitingReply; };
    const concurrent = commandUpdate(109, '/status');
    const requestsBefore = sent.length;
    const firstRequest = webhook(concurrent);
    try {
      await replyStarted;
      assert.equal((await webhook(concurrent)).status, 503);
      assert.equal(sent.length, requestsBefore + 1);
    } finally { releaseReply(); }
    assert.equal((await firstRequest).status, 200);
    assert.equal((await webhook(concurrent)).status, 200);
    assert.equal(sent.length, requestsBefore + 1);
    const task = minimalTask({ id: randomUUID(), title: 'Действие', due_at: Date.now() - 1000, updated_at: 123, status: 'pending', seller: 'excluded' } as Parameters<typeof minimalTask>[0]);
    assert.deepEqual(Object.keys(task).sort(), ['due_at', 'id', 'revision', 'status', 'title']);
    assert.equal((await handleRequest(new Request('https://fixture.invalid/v1/tasks', { method: 'POST', body: '[]' }), env)).status, 401);
    const api = (path: string, data?: unknown) => handleRequest(new Request(`https://fixture.invalid/v1/${path}`, {
      headers, method: data === undefined ? 'GET' : 'POST', ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }), env);
    const click = (update_id: number, data: string, chatId = 42, message_id = 100) => webhook({ update_id,
      callback_query: { id: String(update_id), data, from: { id: chatId }, message: { message_id, chat: { id: chatId, type: 'private' } } } });
    const message = (update_id: number, text: string, replyId?: number) => webhook({ update_id,
      message: { text, chat: privateChat, from: sender, ...(replyId ? { reply_to_message: { message_id: replyId } } : {}) } });
    const buttons = (entry: Record<string, unknown>) => (entry.reply_markup as { inline_keyboard: { callback_data?: string; url?: string }[][] }).inline_keyboard.flat();
    await api('quiet-hours', { timezone: 'Europe/Moscow', start: 0, end: 0, morning: -1, evening: -1 });
    assert.equal((await handleRequest(new Request('https://fixture.invalid/v1/tasks', { method: 'POST', headers, body: JSON.stringify([task]) }), env)).status, 200);
    sent.length = 0;
    await sendDue(env); await sendDue(env); assert.equal(sent.length, 1);
    const callback = buttons(sent[0]!)[0]!.callback_data!;
    assert.ok(callback.length <= 64);
    await click(2, callback, 99);
    assert.equal((await c.getAllAsync('SELECT * FROM remote_actions')).length, 0);
    await click(3, callback);
    await click(3, callback);
    await click(4, callback);
    const actions = await (await handleRequest(new Request('https://fixture.invalid/v1/actions?after=0', { headers }), env)).json() as { seq: number; action: string; revision: number }[];
    assert.equal(actions.length, 1); assert.equal(actions[0]?.action, 'done'); assert.equal(actions[0]?.revision, 123);
    const upload = () => handleRequest(new Request('https://fixture.invalid/v1/tasks', { method: 'POST', headers, body: JSON.stringify([{ ...task, revision: 124 }]) }), env);
    assert.equal((await upload()).status, 409);
    await handleRequest(new Request('https://fixture.invalid/v1/actions/ack', { method: 'POST', headers, body: JSON.stringify(actions[0]!.seq) }), env);
    assert.equal((await upload()).status, 200);
    assert.equal((await upload()).status, 200); // Retrying an already accepted revision is harmless.
    const local = await fixture();
    try {
      const { deviceId } = await (await api('device')).json() as { deviceId?: string };
      const device = (await c.getFirstAsync<{ id: string }>('SELECT id FROM devices'))!.id;
      assert.equal(deviceId, undefined); // The device endpoint returns status only.
      const car = await local.repo.createVehicle({ title: 'Haval <F7>', make: '', model: '', note: 'Личная заметка', phone: '+12025550147' }, null);
      const call = await local.repo.saveTask({ vehicle_id: car, title: 'Позвонить +1 202 555-0147', due_at: Date.now() - 1000, status: 'pending', repeat_mode: 'daily' });
      const offline = await local.repo.telegramOutbox(device, true);
      assert.ok(await local.repo.telegramPending(device));
      const projected = offline.find(row => row.id === call)!;
      assert.equal(projected.call, true); assert.ok(!JSON.stringify(offline).includes('555-0147') && !JSON.stringify(offline).includes('Личная заметка'));
      assert.equal((await api('tasks', offline)).status, 200);
      await local.repo.confirmTelegramUpload(device, offline);
      assert.equal(await local.repo.telegramPending(device), 0);
      sent.length = 0;
      await sendDue(env);
      const alert = sent.find(entry => String(entry.text).includes('Haval &lt;F7&gt;'))!;
      assert.ok(alert);
      const move = buttons(alert).find(button => button.callback_data?.startsWith('move:'))!.callback_data!;
      await click(10, move);
      const pick = buttons(sent.at(-1)!)[0]!.callback_data!;
      await click(11, pick);
      const confirm = buttons(sent.at(-1)!)[0]!.callback_data!;
      await click(12, confirm);
      const moved = await (await api('actions?after=0')).json() as import('../src/services/telegram-protocol').RemoteAction[];
      assert.equal(moved.length, 1); assert.equal(moved[0]!.action, 'snooze');
      assert.equal(await local.repo.applyTelegramActions(device, moved), 0);
      assert.equal((await local.repo.pendingReminders()).find(row => row.task_id === call)?.due_at, moved[0]!.due_at);
      const movedSeq = moved[0]!.seq;
      await api('actions/ack', { seq: movedSeq, outcomes: await local.repo.telegramReceipts(device, movedSeq) });
      const changed = await local.repo.telegramOutbox(device, true);
      await api('tasks', changed); await local.repo.confirmTelegramUpload(device, changed);
      assert.equal((await c.getFirstAsync<{ next_send: number }>('SELECT next_send FROM remote_tasks WHERE id=?', call))?.next_send, moved[0]!.due_at);

      await message(13, '/tasks');
      const show = buttons(sent.at(-1)!).find(button => button.callback_data?.startsWith('show:'))!.callback_data!;
      await click(14, show);
      const done = buttons(sent.at(-1)!).find(button => button.callback_data?.startsWith('done:'))!.callback_data!;
      await click(15, done);
      const offer = sent.findLast(entry => entry.text === 'Добавить итог разговора?')!;
      await click(16, buttons(offer)[0]!.callback_data!);
      const promptId = sent.length;
      await message(17, 'Чужой ответ', promptId - 1);
      await message(18, 'Созвонились, договорились об осмотре.', promptId);
      await message(18, 'Созвонились, договорились об осмотре.', promptId);
      const actions = await (await api(`actions?after=${movedSeq}`)).json() as import('../src/services/telegram-protocol').RemoteAction[];
      assert.deepEqual(actions.map(a => a.action), ['done', 'note']);
      assert.equal(await local.repo.applyTelegramActions(device, actions), 0);
      assert.equal(await local.repo.applyTelegramActions(device, actions), 0);
      const detail = await local.repo.getVehicle(car);
      assert.equal(detail?.notes.filter(note => note.body.includes('договорились')).length, 1);
      assert.equal((await local.repo.listTasks(car)).filter(t => t.status === 'pending').length, 1);
      const seq = actions.at(-1)!.seq;
      assert.ok(!sent.some(entry => String(entry.text).includes('Итог разговора сохранён')));
      await api('actions/ack', { seq, outcomes: await local.repo.telegramReceipts(device, seq) });
      await sendDue(env);
      assert.ok(sent.some(entry => String(entry.text).includes('Итог разговора сохранён')));
      assert.equal((await c.getFirstAsync<{ value: string | null }>('SELECT value FROM remote_actions WHERE seq=?', seq))?.value, null);

      const oldCar = await local.repo.createVehicle({ title: 'Mazda', make: '', model: '', note: '' }, null);
      await local.c.runAsync('UPDATE lots SET last_contact_at=? WHERE id=?', Date.now() - 21 * 86400000, oldCar);
      async function publishLocal() {
        const rows = await local.repo.telegramOutbox(device, true);
        assert.equal((await api('tasks', rows)).status, 200);
        await local.repo.confirmTelegramUpload(device, rows);
      }
      async function receive(after: number, expected: string) {
        const batch = await (await api(`actions?after=${after}`)).json() as import('../src/services/telegram-protocol').RemoteAction[];
        assert.deepEqual(batch.map(a => a.action), [expected]);
        assert.equal(await local.repo.applyTelegramActions(device, batch), 0);
        const received = batch[0]!.seq;
        assert.equal((await api('actions/ack', { seq: received, outcomes: await local.repo.telegramReceipts(device, received) })).status, 200);
        return received;
      }
      await publishLocal();
      await message(19, '/contact');
      await click(20, buttons(sent.at(-1)!)[0]!.callback_data!);
      const review = sent.at(-1)!;
      assert.ok(String(review.text).includes('Проверить актуальность'));
      assert.ok(buttons(review).some(b => b.url?.includes(`/open/vehicle/${oldCar}`)));
      await click(21, buttons(review).find(b => b.callback_data?.startsWith('archive:'))!.callback_data!);
      await click(22, buttons(sent.at(-1)!)[2]!.callback_data!);
      assert.equal((await local.repo.getVehicle(oldCar))?.vehicle.status, 'cold');
      await click(23, buttons(sent.at(-1)!)[0]!.callback_data!);
      const archivedSeq = await receive(seq, 'archive');
      assert.equal((await local.repo.getVehicle(oldCar))?.vehicle.completion_reason, 'declined');
      await local.c.runAsync('UPDATE lots SET archived_at=? WHERE id=?', Date.now() - 21 * 86400000, oldCar);
      await publishLocal();
      await message(24, '/archive');
      await click(25, buttons(sent.at(-1)!)[0]!.callback_data!);
      const archivedReview = sent.at(-1)!;
      assert.ok(buttons(archivedReview).some(b => b.url?.endsWith(`/vehicle/${oldCar}?app=autocrm-showcase`)));
      await click(26, buttons(archivedReview).find(b => b.callback_data?.startsWith('restore:'))!.callback_data!);
      await receive(archivedSeq, 'restore');
      assert.equal((await local.repo.getVehicle(oldCar))?.vehicle.status, 'cold');
      await publishLocal();
      const open = await handleRequest(new Request(`https://fixture.invalid/open/vehicle/${oldCar}?app=autocrm-showcase-dev`), env);
      assert.ok((await open.text()).includes(`autocrm-showcase-dev://vehicle/${oldCar}`));
      assert.equal((await handleRequest(new Request('https://fixture.invalid/open/vehicle/not-a-uuid'), env)).status, 404);

      const near = { ...task, id: randomUUID(), revision: 200, due_at: Date.now() - 1000 };
      await api('tasks', [near]);
      failNextSend = true;
      const now = Date.now();
      await sendDue(env, now);
      const retry = await c.getFirstAsync<{ next_send: number }>('SELECT next_send FROM remote_tasks WHERE id=?', near.id);
      assert.equal(retry?.next_send, now + 120000);
      const prior = sent.length;
      await sendDue(env, now + 60000); assert.equal(sent.length, prior);
      await sendDue(env, now + 120000);
      const repeatAt = now + 120000 + 30 * 60000;
      assert.equal((await c.getFirstAsync<{ next_send: number }>('SELECT next_send FROM remote_tasks WHERE id=?', near.id))?.next_send, repeatAt);
      await sendDue(env, repeatAt - 1);
      assert.equal((await c.getFirstAsync<{ sent_count: number }>('SELECT sent_count FROM remote_tasks WHERE id=?', near.id))?.sent_count, 1);
      await sendDue(env, repeatAt); await sendDue(env, repeatAt); await sendDue(env, now + 7200000);
      assert.equal((await c.getFirstAsync<{ sent_count: number }>('SELECT sent_count FROM remote_tasks WHERE id=?', near.id))?.sent_count, 2);
      const { wallTime } = await import('../server/telegram/local-time');
      const digestAt = now + 7200000;
      await api('quiet-hours', { timezone: 'Europe/Moscow', start: 0, end: 0, morning: wallTime(digestAt, 'Europe/Moscow').hour, evening: -1 });
      const digests = () => sent.filter(entry => String(entry.text).includes('Утренняя сводка')).length;
      await sendDue(env, digestAt); await sendDue(env, digestAt);
      assert.equal(digests(), 1);
    } finally { local.db.close(); }
    for (let index = 0; index < 6; index++) {
      const trial = await handleRequest(new Request('https://fixture.invalid/v1/pair', {
        method: 'POST', headers: { 'CF-Connecting-IP': '192.0.2.12' }, body: JSON.stringify({ pairingVersion: 2 }),
      }), env);
      assert.equal(trial.status, index < 5 ? 200 : 429);
    }
    await handleRequest(new Request('https://fixture.invalid/v1/device', { method: 'DELETE', headers }), env);
    assert.equal((await handleRequest(new Request('https://fixture.invalid/v1/device', { headers }), env)).status, 401);
    assert.equal((await c.getAllAsync('SELECT * FROM remote_tasks')).length, 0);
    assert.equal(quietNow(Date.UTC(2026, 0, 1, 20), 'Europe/Moscow', 22, 8), true);
    assert.equal(quietNow(Date.UTC(2026, 0, 1, 10), 'Europe/Moscow', 22, 8), false);
  } finally { db.close(); }
});

test('Telegram beta audit: two confirmed chats isolate tasks, callbacks, ACKs, Cron and revoke', async () => {
  const { handleRequest, sendDue } = await import('../server/telegram/worker');
  const { digest } = await import('../src/services/telegram-protocol');
  const { pairingOffer } = await import('../src/services/telegram-pairing');
  type Statement = import('../server/telegram/worker').Statement;
  type Action = import('../src/services/telegram-protocol').RemoteAction;
  const SQL = await sqlite, db = new SQL.Database(), c = connection(db);
  const localA = await fixture(), localB = await fixture();
  db.exec('PRAGMA foreign_keys=ON');
  const migrations = readdirSync('server/telegram/migrations').sort();
  for (const file of migrations.slice(0, 2)) db.exec(readFileSync(join('server/telegram/migrations', file), 'utf8'));
  const legacyId = randomUUID(), legacyToken = randomUUID().replaceAll('-', '').repeat(2);
  const legacyWaitingId = randomUUID(), legacyWaitingToken = randomUUID().replaceAll('-', '').repeat(2);
  const legacyCode = randomUUID().replaceAll('-', '');
  const legacyTask = randomUUID(), legacyChat = '799';
  await c.runAsync('INSERT INTO devices(id,token_hash,chat_id,morning,evening) VALUES(?,?,?,-1,-1)', legacyId, await digest(legacyToken), legacyChat);
  await c.runAsync("INSERT INTO remote_tasks(device_id,id,title,due_at,revision,status,next_send,callback_token) VALUES(?,?,?,0,1,'done',0,?)",
    legacyId, legacyTask, 'Legacy fixture', randomUUID());
  await c.runAsync("INSERT INTO remote_actions(device_id,task_id,action,revision,created_at) VALUES(?,?,'done',1,?)",
    legacyId, legacyTask, Date.now());
  await c.runAsync('INSERT INTO devices(id,token_hash,pair_hash,pair_expires) VALUES(?,?,?,?)',
    legacyWaitingId, await digest(legacyWaitingToken), await digest('fixture-pepper' + legacyCode), Date.now() + 600000);
  for (const file of migrations.slice(2)) db.exec(readFileSync(join('server/telegram/migrations', file), 'utf8'));
  let failStatement: string | undefined;
  function prepare(sql: string, values: (string | number | null)[] = []): Statement {
    if (failStatement && sql.includes(failStatement)) {
      failStatement = undefined;
      throw new Error('Fixture connection lost');
    }
    return { bind: (...args) => prepare(sql, args), first: <T>() => c.getFirstAsync<T>(sql, ...values),
      all: async <T>() => ({ results: await c.getAllAsync<T>(sql, ...values) }),
      run: async () => ({ meta: { changes: (await c.runAsync(sql, ...values)).changes } }) };
  }
  const env: Environment = { DB: { prepare, batch: async (statements: Statement[]) => {
    const results: Awaited<ReturnType<Statement['run']>>[] = [];
    await c.withTransactionAsync(async () => { for (const statement of statements) results.push(await statement.run()); });
    return results;
  } }, FIXTURE_BOT_NAME: 'fixture_bot', FIXTURE_WEBHOOK_KEY: 'fixture-secret', FIXTURE_PAIRING_PEPPER: 'fixture-pepper' };
  const sent: { chat_id?: number | string; text?: string; reply_markup?: { inline_keyboard: { callback_data?: string }[][] } }[] = [];
  env.telegramFixture = async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: { message_id: sent.length } });
  };
  const request = (path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) =>
    handleRequest(new Request(`https://fixture.invalid/${path}`, { method, headers,
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) }), env);
  let update = 1000;
  const webhook = (data: unknown, id = ++update) => request('webhook', 'POST', { update_id: id, ...(data as object) },
    { 'X-Telegram-Bot-Api-Secret-Token': env.FIXTURE_WEBHOOK_KEY });
  const command = (id: number, text: string) => webhook({ message: { text, from: { id, first_name: `Fixture ${id}`, username: `fixture_${id}` }, chat: { id, type: 'private' } } });
  const callback = (chat: number, data: string, sender = chat) => ({
    callback_query: { id: 'fixture-callback', data, from: { id: sender }, message: { message_id: 17, chat: { id: chat, type: 'private' } } },
  });
  const button = (prefix: string) => sent.at(-1)?.reply_markup?.inline_keyboard.flat().find(item => item.callback_data?.startsWith(prefix))?.callback_data;
  async function pair(app: string) {
    const res = await request('v1/pair', 'POST', { app, pairingVersion: 2 });
    assert.equal(res.status, 200);
    const result = await res.json() as { deviceId: string; deviceToken: string; bindUrl: string };
    const start = '/start ' + new URL(result.bindUrl).searchParams.get('start');
    const api = (path: string, method = 'GET', data?: unknown) => request('v1/' + path, method, data,
      { Authorization: 'Bearer ' + result.deviceToken });
    return { id: result.deviceId, start, api };
  }
  const proofFor = (chat: number) => /Код подтверждения Auto CRM: ([a-f0-9]{12})/.exec(sent.findLast(row => Number(row.chat_id) === chat)?.text ?? '')?.[1];
  async function confirm(device: Awaited<ReturnType<typeof pair>>, chat: number) {
    const state = await (await device.api('device')).json() as { linked: boolean; candidate: { requestId: string } };
    assert.equal(state.linked, false);
    const code = proofFor(chat);
    assert.ok(code);
    return device.api('device/pairing', 'POST', { requestId: state.candidate.requestId, approve: true, code });
  }
  const markA = 'ONLY-FIXTURE-A', markB = 'ONLY-FIXTURE-B', chatA = 701, chatB = 702, chatC = 703;
  const checkDelivery = (chat: number, own: string, other: string, from: number) => {
    const messages = sent.slice(from).filter(row => row.chat_id !== undefined);
    assert.ok(messages.length);
    assert.ok(messages.every(row => Number(row.chat_id) === chat && !row.text?.includes(other)));
    if (own) assert.ok(messages.some(row => row.text?.includes(own)));
  };
  try {
    const legacyHeaders = { Authorization: `Bearer ${legacyToken}` };
    assert.deepEqual(await (await request('v1/device', 'GET', undefined, legacyHeaders)).json(), { linked: true });
    assert.equal((await request('v1/quiet-hours', 'POST', {
      timezone: 'Europe/Moscow', start: 0, end: 0, morning: -1, evening: -1, app: 'autocrm-showcase',
    }, legacyHeaders)).status, 200);
    const [action] = await (await request('v1/actions?after=0', 'GET', undefined, legacyHeaders)).json() as Action[];
    assert.ok(action);
    assert.equal(action.task_id, legacyTask);
    assert.equal(action.action, 'done');
    assert.deepEqual(await (await request('v1/actions/ack', 'POST', {
      seq: action.seq, outcomes: [{ seq: action.seq, state: 'applied' }],
    }, legacyHeaders)).json(), { ok: true });
    assert.equal((await c.getFirstAsync<{ outcome: string }>('SELECT outcome FROM remote_actions WHERE seq=?', action.seq))?.outcome, 'applied');
    const legacyUpload = [{ id: legacyTask, title: 'Legacy fixture', due_at: 0, revision: 2, status: 'done' }];
    assert.deepEqual(await (await request('v1/tasks', 'POST', legacyUpload, legacyHeaders)).json(), { accepted: true });
    assert.deepEqual(await (await request('v1/tasks', 'POST', legacyUpload, legacyHeaders)).json(), { accepted: true });
    assert.equal((await c.getFirstAsync<{ revision: number }>(
      'SELECT revision FROM remote_tasks WHERE device_id=? AND id=?', legacyId, legacyTask))?.revision, 2);
    assert.deepEqual(await (await request(`v1/actions?after=${action.seq}`, 'GET', undefined, legacyHeaders)).json(), []);
    const beforeLegacyDelivery = sent.length;
    await sendDue(env);
    checkDelivery(Number(legacyChat), 'Выполнение подтверждено в CRM', markA, beforeLegacyDelivery);
    assert.equal((await request('v1/pair', 'POST', { app: 'autocrm-showcase' })).status, 426);
    const oldOffer = { deviceId: legacyWaitingId, deviceToken: legacyWaitingToken, bindUrl: `https://telegram.fixture.invalid/fixture_bot?start=pair_${legacyCode}` };
    assert.equal(pairingOffer(oldOffer), null);
    assert.equal(pairingOffer({ ...oldOffer, pairingVersion: 2 }), null);
    await command(chatC, '/start pair_' + legacyCode);
    assert.deepEqual(await (await request('v1/device', 'GET', undefined, { Authorization: `Bearer ${legacyWaitingToken}` })).json(), { linked: false });
    assert.equal((await request('v1/tasks', 'POST', [], { Authorization: `Bearer ${legacyWaitingToken}` })).status, 409);
    assert.deepEqual(await c.getFirstAsync('SELECT pair_hash FROM devices WHERE id=?', legacyWaitingId), { pair_hash: null });
    assert.ok(await c.getFirstAsync('SELECT id FROM remote_tasks WHERE device_id=? AND id=?', legacyId, legacyTask));
    failStatement = 'INSERT INTO devices';
    assert.equal((await request('v1/pair', 'POST', { app: 'autocrm-showcase', pairingVersion: 2 }, { 'CF-Connecting-IP': '192.0.2.7' })).status, 503);
    const a = await pair('autocrm-showcase-dev'), duplicate = await pair('autocrm-showcase'), b = await pair('autocrm-showcase');
    assert.equal((await command(chatA, a.start)).status, 200);
    assert.equal((await confirm(a, chatA)).status, 200);
    await command(chatA, duplicate.start);
    assert.deepEqual(await (await duplicate.api('device')).json(), { linked: false, pairingState: 'waiting' });
    assert.equal((await duplicate.api('tasks', 'POST', [])).status, 409);
    await command(chatB, a.start);
    await command(chatB, b.start);
    failStatement = 'SELECT * FROM devices WHERE token_hash';
    assert.equal((await b.api('device')).status, 503);
    failStatement = 'UPDATE devices SET chat_id=pair_chat_id';
    assert.equal((await confirm(b, chatB)).status, 503);
    assert.equal((await b.api('tasks', 'POST', [])).status, 409);
    assert.equal((await confirm(b, chatB)).status, 200);
    assert.deepEqual(await (await a.api('device')).json(), { linked: true });
    assert.deepEqual(await (await b.api('device')).json(), { linked: true });
    assert.deepEqual(await c.getAllAsync('SELECT app_scheme FROM devices WHERE chat_id IN (?,?) ORDER BY chat_id', String(chatA), String(chatB)),
      [{ app_scheme: 'autocrm-showcase-dev' }, { app_scheme: 'autocrm-showcase' }]);
    assert.equal(await c.getFirstAsync('SELECT id FROM devices WHERE chat_id IS NOT NULL AND pair_hash IS NOT NULL'), null);

    const now = Date.now(), commonId = randomUUID(), due = now - 2_000, later = now + 600_000;
    const { dayKey, wallTime } = await import('../server/telegram/local-time');
    const zone = dayKey(due, 'UTC') === dayKey(later, 'UTC') ? 'UTC' : 'Europe/Moscow';
    const carA = await localA.repo.createVehicle({ title: markA, make: '', model: '', note: '' }, null);
    const carB = await localB.repo.createVehicle({ title: markB, make: '', model: '', note: '' }, null);
    for (const [device, local, car, title] of [[a, localA, carA, markA], [b, localB, carB, markB]] as const) {
      const input = { vehicle_id: car, title, due_at: later, status: 'pending' as const, repeat_mode: 'none' as const };
      await local.repo.saveTask(input, commonId);
      await local.repo.saveTask({ ...input, due_at: due });
      const tasks = await local.repo.telegramOutbox(device.id);
      const review = { ...tasks[0]!, id: 'cold:' + car, vehicle_id: car, due_at: due };
      assert.equal((await device.api('tasks', 'POST', [...tasks, review, { ...review, id: 'archive:' + car }])).status, 200);
      await local.repo.confirmTelegramUpload(device.id, tasks);
      const hour = wallTime(now, zone).hour;
      assert.equal((await device.api('quiet-hours', 'POST', { timezone: zone, start: 0, end: 0, morning: hour, evening: hour })).status, 200);
      const from = sent.length;
      assert.equal((await device.api('test', 'POST', {})).status, 200);
      checkDelivery(device === a ? chatA : chatB, 'Тест Auto CRM', device === a ? markB : markA, from);
    }
    for (const [chat, own, other] of [[chatA, markA, markB], [chatB, markB, markA]] as const) {
      for (const name of ['/start','/help','/tasks','/today','/overdue','/contact','/archive','/status','/cancel']) {
        const from = sent.length;
        assert.equal((await command(chat, name)).status, 200);
        checkDelivery(chat, ['/tasks','/today','/overdue','/contact','/archive'].includes(name) ? own : '', other, from);
      }
    }
    const beforeCron = sent.length;
    await sendDue(env, now);
    const cron = sent.slice(beforeCron);
    for (const [chat, own, other] of [[chatA, markA, markB], [chatB, markB, markA]] as const) {
      const messages = cron.filter(row => Number(row.chat_id) === chat);
      assert.ok(messages.some(row => row.text?.includes('Утренняя сводка') && row.text.includes(own)));
      assert.ok(messages.some(row => row.text?.includes('Вечерняя сводка') && row.text.includes(own)));
      assert.ok(messages.some(row => row.text?.includes('Напоминание') && row.text.includes(own)));
      assert.ok(messages.every(row => !row.text?.includes(other)));
    }
    assert.ok(cron.every(row => [chatA, chatB].includes(Number(row.chat_id))));
    await command(chatA, '/tasks');
    await webhook(callback(chatA, button('show:')!));
    const aDone = button('done:')!, aMove = button('move:')!;
    assert.ok(aDone && aMove);
    await command(chatB, '/tasks');
    await webhook(callback(chatB, button('show:')!));
    const bMove = button('move:')!, bDone = button('done:')!;
    assert.ok(bMove && bDone);
    const beforeForeign = sent.length;
    for (const [chat, code, sender] of [[chatA,bDone,chatA], [chatA,bMove,chatA], [chatB,aDone,chatB], [chatB,aMove,chatB], [chatA,aDone,chatB]] as const)
      assert.equal((await webhook(callback(chat, code, sender))).status, 200);
    assert.ok(sent.slice(beforeForeign).every(row => !row.text?.includes(markA) && !row.text?.includes(markB)));
    assert.deepEqual(await c.getAllAsync('SELECT device_id, seq FROM remote_actions'), [{ device_id: legacyId, seq: action.seq }]);
    assert.deepEqual(await c.getAllAsync('SELECT * FROM bot_dialogs'), []);
    const row = (id: string) => c.getFirstAsync('SELECT title,due_at,status FROM remote_tasks WHERE device_id=? AND id=?', id, commonId);
    const aOriginal = await row(a.id);
    await webhook(callback(chatB, bMove));
    await webhook(callback(chatB, button('m15:')!));
    const confirmation = callback(chatB, button('confirm:')!);
    const replay = ++update;
    await webhook(confirmation, replay);
    await webhook(confirmation, replay);
    const changes = await (await b.api('actions?after=0')).json() as Action[];
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.action, 'snooze');
    assert.deepEqual(await (await a.api('actions?after=0')).json(), []);
    assert.equal((await a.api('actions/ack', 'POST', { seq: changes[0]!.seq, outcomes: [{ seq: changes[0]!.seq, state: 'applied' }] })).status, 200);
    assert.deepEqual(await (await b.api('actions?after=0')).json(), changes);
    assert.equal(await localB.repo.applyTelegramActions(b.id, changes), 0);
    assert.equal((await localB.repo.getTask(commonId))?.due_at, changes[0]?.due_at);
    assert.equal((await localA.repo.getTask(commonId))?.due_at, later);
    assert.deepEqual(await row(a.id), aOriginal);
    assert.equal((await b.api('actions/ack', 'POST', { seq: changes[0]!.seq, outcomes: [{ seq: changes[0]!.seq, state: 'applied' }] })).status, 200);
    assert.equal((await b.api('tasks', 'POST', await localB.repo.telegramOutbox(b.id))).status, 200);
    await webhook(callback(chatA, aDone));
    const done = await (await a.api('actions?after=0')).json() as Action[];
    assert.equal(done[0]?.action, 'done');
    assert.equal(await localA.repo.applyTelegramActions(a.id, done), 0);
    assert.equal((await localA.repo.getTask(commonId))?.status, 'done');
    assert.equal((await localB.repo.getTask(commonId))?.status, 'pending');
    assert.deepEqual(await (await b.api('actions?after=0')).json(), []);
    const bOriginal = await row(b.id);
    assert.equal((await a.api('device', 'DELETE')).status, 200);
    assert.equal((await a.api('device')).status, 401);
    assert.deepEqual(await row(b.id), bOriginal);
    assert.deepEqual(await (await b.api('device')).json(), { linked: true });

    // The wrong account used the link first. Even its own Telegram chat cannot see any tasks.
    await command(chatC, duplicate.start);
    const queued = await (await duplicate.api('device')).json() as { linked: boolean; pairingState: string; candidate: { requestId: string; username: string } };
    assert.equal(queued.linked, false);
    assert.equal(queued.pairingState, 'pending');
    assert.equal(queued.candidate.username, `fixture_${chatC}`);
    assert.ok(proofFor(chatC));
    await command(chatA, duplicate.start);
    assert.deepEqual(await (await duplicate.api('device')).json(), queued);
    assert.equal(proofFor(chatA), undefined);
    const misplaced = await localB.repo.telegramOutbox(duplicate.id);
    assert.equal((await duplicate.api('tasks', 'POST', misplaced)).status, 409);
    assert.equal((await duplicate.api('actions')).status, 409);
    assert.equal((await duplicate.api('test', 'POST', {})).status, 409);
    assert.equal((await b.api('device/pairing', 'POST', { approve: true, requestId: queued.candidate.requestId, code: proofFor(chatC) })).status, 409);
    assert.equal((await duplicate.api('device/pairing', 'POST', { approve: true, requestId: queued.candidate.requestId, code: 'f'.repeat(12) })).status, 403);
    const beforeMisplaced = sent.length;
    await command(chatC, '/tasks');
    checkDelivery(chatC, '', markB, beforeMisplaced);
    const reject = () => duplicate.api('device/pairing', 'POST', { approve: false, requestId: queued.candidate.requestId });
    failStatement = 'UPDATE devices SET pair_hash=NULL,pair_chat_id=NULL';
    assert.equal((await reject()).status, 503);
    assert.equal((await duplicate.api('tasks', 'POST', misplaced)).status, 409);
    assert.equal((await reject()).status, 200);
    assert.equal((await reject()).status, 200);
    await command(chatA, duplicate.start);
    assert.equal((await duplicate.api('device/pairing', 'POST', { approve: true, requestId: queued.candidate.requestId, code: proofFor(chatC) })).status, 409);
    assert.deepEqual(await (await duplicate.api('device')).json(), { linked: false, pairingState: 'rejected' });
    assert.equal((await duplicate.api('device', 'DELETE')).status, 200);
    const expired = await pair('autocrm-showcase');
    await Promise.all([command(chatA, expired.start), command(chatC, expired.start)]);
    const expiredRequest = await (await expired.api('device')).json() as { linked: boolean; candidate: { requestId: string; username: string } };
    assert.equal(expiredRequest.linked, false);
    assert.equal(Number(!!proofFor(chatA)) + Number(!!proofFor(chatC)), 1);
    const expiredProof = proofFor(expiredRequest.candidate.username === `fixture_${chatA}` ? chatA : chatC);
    assert.ok(expiredProof);
    await c.runAsync('UPDATE devices SET pair_expires=? WHERE id=?', Date.now() - 1, expired.id);
    assert.equal((await expired.api('device/pairing', 'POST', { approve: true, requestId: expiredRequest.candidate.requestId, code: expiredProof })).status, 409);
    await command(chatA, expired.start);
    assert.deepEqual(await (await expired.api('device')).json(), { linked: false, pairingState: 'expired' });
    failStatement = 'DELETE FROM devices WHERE id';
    assert.equal((await b.api('device', 'DELETE')).status, 503);
    assert.deepEqual(await (await b.api('device')).json(), { linked: true });
    assert.equal((await b.api('device', 'DELETE')).status, 200);
    assert.equal((await b.api('device', 'DELETE')).status, 401);
    const reconnect = await pair('autocrm-showcase');
    await command(chatB, reconnect.start);
    assert.equal((await confirm(reconnect, chatB)).status, 200);
    assert.deepEqual(await (await reconnect.api('device')).json(), { linked: true });
  } finally { db.close(); localA.db.close(); localB.db.close(); }
});

test('reopening a completed task preserves its deadline, history and next recurring occurrence', async () => {
  const { db, repo } = await fixture();
  try {
    const vehicle = await repo.createVehicle({ make: '', model: '', title: 'Fixture', note: '' }, null);
    const device = randomUUID();
    const input = { vehicle_id: vehicle, title: 'Напоминание', due_at: Date.now() + 120000, status: 'pending' as const, repeat_mode: 'weekly' as const };
    const id = await repo.saveTask(input);
    const first = await repo.telegramOutbox(device);
    await repo.confirmTelegramUpload(device, first);
    assert.equal(await repo.applyTelegramActions(device, [{ seq: 1, task_id: id, action: 'done', due_at: null, revision: first[0]!.revision }]), 0);
    const completed = (await repo.getTask(id))!;
    const next = (await repo.listTasks(vehicle)).find(task => task.id !== id)!;
    await repo.confirmTelegramUpload(device, await repo.telegramOutbox(device));
    await repo.reopenTask(id, completed.updated_at);
    await assert.rejects(repo.reopenTask(id, completed.updated_at), /изменилась/);
    const restored = (await repo.getTask(id))!;
    assert.deepEqual([restored.id, restored.status, restored.due_at, restored.completed_at, restored.repeat_mode], [id, 'pending', input.due_at, null, 'none']);
    assert.ok((await repo.pendingReminders()).some(reminder => reminder.task_id === id));
    assert.ok((await repo.telegramOutbox(device)).some(task => task.id === id && task.status === 'pending'));
    await repo.completeTask(id);
    assert.equal((await repo.listTasks(vehicle)).filter(task => task.status === 'pending').length, 1);
    assert.equal((await repo.getTask(next.id))?.repeat_mode, 'weekly');
    assert.ok((await repo.getVehicle(vehicle))?.events.some(event => event.kind === 'task_done'));
    const expired = await repo.saveTask({ ...input, due_at: Date.now() - 1000, repeat_mode: 'none' });
    await repo.completeTask(expired);
    await repo.reopenTask(expired, (await repo.getTask(expired))!.updated_at);
    assert.ok((await repo.getTask(expired))!.due_at < Date.now());
    assert.ok(!(await repo.pendingReminders()).some(reminder => reminder.task_id === expired));
  } finally { db.close(); }
});

test('Telegram custom deadlines reject past times, impossible dates and both ambiguous DST occurrences', async () => {
  const { parseDeadline, calendarDeadline } = await import('../server/telegram/local-time');
  const now = Date.UTC(2026, 11, 31, 20, 30);
  assert.equal(parseDeadline('01.01 10:00', now, 'Europe/Moscow'), Date.UTC(2027, 0, 1, 7));
  assert.equal(parseDeadline('31.12 22:00', now, 'Europe/Moscow'), null);
  assert.equal(parseDeadline('31.02 10:00', now, 'Europe/Moscow'), null);
  assert.equal(parseDeadline('29.03.2026 02:30', Date.UTC(2026, 2, 1), 'Europe/Berlin'), null);
  assert.equal(parseDeadline('25.10.2026 02:30', Date.UTC(2026, 9, 1), 'Europe/Berlin'), null);
  assert.equal(calendarDeadline(now, 'Europe/Moscow', 1, 10), Date.UTC(2027, 0, 1, 7));
});

test('Telegram mobile outbox retries identical revisions; actions are idempotent and cannot overwrite newer local edits', async () => {
  const { db, repo } = await fixture();
  try {
    const car = await repo.createVehicle({ make: '', model: '', title: 'Лот', note: '' }, null);
    const input = { vehicle_id: car, title: 'Действие', due_at: Date.now() + 600000, status: 'pending' as const, repeat_mode: 'daily' as const };
    const id = await repo.saveTask(input), device = randomUUID();
    const first = await repo.telegramOutbox(device);
    assert.equal(first.length, 1); assert.deepEqual(await repo.telegramOutbox(device), first);
    await repo.confirmTelegramUpload(device, first); assert.equal((await repo.telegramOutbox(device)).length, 0);
    const action = { seq: 1, task_id: id, action: 'done' as const, due_at: null, revision: first[0]!.revision };
    assert.equal(await repo.applyTelegramActions(device, [action]), 0);
    assert.equal(await repo.applyTelegramActions(device, [action]), 0);
    let tasks = await repo.listTasks(car);
    assert.equal(tasks.filter(t => t.status === 'done').length, 1); assert.equal(tasks.filter(t => t.status === 'pending').length, 1);
    const repeated = tasks.find(t => t.status === 'pending')!;
    const second = await repo.telegramOutbox(device); await repo.confirmTelegramUpload(device, second);
    const sentRepeat = second.find(t => t.id === repeated.id)!;
    await repo.saveTask({ ...repeated, title: 'Локальная правка' }, repeated.id);
    assert.equal(await repo.applyTelegramActions(device, [{ ...action, seq: 2, task_id: repeated.id, revision: sentRepeat.revision }]), 1);
    tasks = await repo.listTasks(car);
    assert.equal(tasks.find(t => t.id === repeated.id)?.status, 'pending');
    assert.equal(tasks.find(t => t.id === repeated.id)?.title, 'Локальная правка');
    await assert.rejects(repo.saveTask({ ...repeated, title: 'Устаревший редактор' }, repeated.id, repeated.updated_at), /изменилась/);
    await repo.changeStage(car, 'completed', 'declined');
    const archived = await repo.telegramOutbox(device);
    assert.equal(archived.find(t => t.id === repeated.id)?.status, 'done');
  } finally { db.close(); }
});

test('exact alarm grant cancels old requests before rearming future tasks and reports missing schedules', async () => {
  const { db, repo } = await fixture();
  try {
    const car = await repo.createVehicle({ make: '', model: '', title: 'Лот', note: '' }, null);
    const input = { vehicle_id: car, title: 'Осмотр', status: 'pending' as const, repeat_mode: 'none' as const, due_at: Date.now() + 60_000 };
    await repo.saveTask(input);
    await repo.saveTask({ ...input, due_at: Date.now() - 60_000 });
    const native = new Map<string, number>(), operations: string[] = [], discrepancies: number[] = [];
    const reconcile = createReminderReconciler({
      list: async () => [...native].map(([id, at]) => ({ id, at })),
      cancel: async id => { operations.push('cancel'); native.delete(id); },
      schedule: async ({ id, at }) => { operations.push('schedule'); native.set(id, at.getTime()); return id; },
    }, false, (event, values) => { if (event === 'alarm.snapshot') discrepancies.push(values?.count ?? -1); });
    await reconcile(repo);
    const previous = [...native.keys()][0]!;
    assert.ok(previous);
    await repo.rescheduleAllReminders({ key: 'notification_exact', value: 'on' });
    await reconcile(repo);
    assert.equal(await repo.getSetting('notification_exact'), 'on');
    assert.deepEqual(operations, ['schedule', 'cancel', 'schedule']);
    assert.equal(native.size, 1);
    assert.equal(native.has(previous), false);
    native.clear();
    await reconcile(repo);
    assert.equal(native.size, 1);
    assert.deepEqual(discrepancies, [1, 1, 1]);
  } finally { db.close(); }
});

test('a refreshed repository replaces the old instance while preserving the open database and transaction queue', async () => {
  const SQL = await sqlite;
  const db = new SQL.Database();
  const c = connection(db);
  let opens = 0, closes = 0, migrationsRun = 0;
  const load = createRepositorySession(async () => {
    opens++;
    return { ...c, async closeAsync() { closes++; } };
  }, async conn => { migrationsRun++; await migrate(conn); }, randomUUID);
  class RefreshedRepository extends CrmRepository {}
  try {
    const first = load(CrmRepository);
    assert.equal(load(CrmRepository), first);
    const [old, current] = await Promise.all([first, load(RefreshedRepository)]);
    assert.notEqual(old, current);
    assert.equal(current.constructor, RefreshedRepository);
    assert.equal(typeof current.subscribeTaskChanges, 'function');
    const car = await old.createVehicle({ make: '', model: '', title: 'Лот', note: '' }, null);
    await Promise.all([old.setSetting('old-runtime-write', '1'), current.setSetting('current-write', '2')]);
    assert.equal((await current.getVehicle(car))?.vehicle.id, car);
    assert.equal(await current.getSetting('old-runtime-write'), '1');
    assert.equal(await old.getSetting('current-write'), '2');
    assert.deepEqual([opens, migrationsRun, closes], [1, 1, 0]);
  } finally { db.close(); }
});

test('failed database initialization can be retried without retaining its connection', async () => {
  const { db, c } = await fixture();
  let opens = 0, closes = 0;
  const load = createRepositorySession(async () => {
    opens++;
    return { ...c, async closeAsync() { closes++; throw new Error('Invalid native handle'); } };
  }, async conn => {
    if (opens === 1) throw new Error('Migration failed');
    await migrate(conn);
  }, randomUUID);
  try {
    await assert.rejects(load(CrmRepository), /Migration failed/);
    const current = await load(CrmRepository);
    assert.equal(await load(CrmRepository), current);
    assert.deepEqual(await current.listTasks(), []);
    assert.deepEqual([opens, closes], [2, 1]);
  } finally { db.close(); }
});

test('a refreshed observer tolerates the old contract and drops work from its disposed subscription', async () => {
  const { db, repo } = await fixture();
  let runs = 0, finish = () => {};
  let inFlight: Promise<void> | null = new Promise<void>(resolve => { finish = resolve; }).finally(() => { inFlight = null; });
  const sync = async () => { runs++; };
  const observe = (source: Pick<CrmRepository, 'subscribeTaskChanges'>) => observeTelegramTaskChanges(source, () => true, () => inFlight, sync);
  const stopLegacy = observe({} as CrmRepository);
  stopLegacy();
  const stopOld = observe(repo);
  let stopCurrent = () => {};
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    const car = await repo.createVehicle({ make: '', model: '', title: 'Лот', note: '' }, null);
    const input = { vehicle_id: car, title: 'Звонок', due_at: Date.now() + 60_000, status: 'pending' as const, repeat_mode: 'none' as const };
    const id = await repo.saveTask(input);
    stopOld();
    stopCurrent = observe(repo);
    await repo.saveTask({ ...input, title: 'Уточнить' }, id);
    assert.equal(runs, 0);
    finish();
    await tick();
    assert.equal(runs, 1);
  } finally { stopOld(); stopCurrent(); finish(); await inFlight; db.close(); }
});

test('a committed task starts sync immediately and edits during an upload produce one follow-up', async () => {
  const { db, c, repo } = await fixture();
  const device = randomUUID();
  const batches: RemoteTask[][] = [];
  let running: Promise<void> | null = null;
  let release = () => {};
  const firstAck = new Promise<void>(resolve => { release = resolve; });
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  const stop = observeTelegramTaskChanges(repo, () => true, () => running, () => {
    assert.equal(running, null);
    running = (async () => {
      const tasks = await repo.telegramOutbox(device, true);
      batches.push(tasks);
      if (batches.length === 1) await firstAck;
      await repo.confirmTelegramUpload(device, tasks);
    })().finally(() => { running = null; });
    return running;
  });
  try {
    const car = await repo.createVehicle({ make: '', model: '', title: 'Лот', note: '' }, null);
    const id = randomUUID();
    const input = { vehicle_id: car, title: 'Звонок', due_at: Date.now() + 60_000, status: 'pending' as const, repeat_mode: 'none' as const };
    await c.execAsync("CREATE TRIGGER fail_task BEFORE INSERT ON lot_tasks BEGIN SELECT RAISE(ABORT,'disk write failed'); END");
    await assert.rejects(repo.saveTask(input, id), /disk write failed/);
    await tick();
    assert.equal(batches.length, 0);
    await c.execAsync('DROP TRIGGER fail_task');
    await repo.saveTask(input, id);
    await tick();
    assert.equal(batches.length, 1);
    const original = batches[0]!.find(task => task.id === id)!;
    assert.equal(original.status, 'pending');
    assert.equal(original.due_at, input.due_at);
    assert.ok(await repo.telegramPending(device));

    const due = input.due_at + 120_000;
    await Promise.all([
      repo.saveTask({ ...input, due_at: due }, id),
      repo.saveTask({ ...input, due_at: due, title: 'Уточнить цену' }, id),
      repo.completeTask(id),
    ]);
    assert.equal(batches.length, 1);
    assert.equal((await repo.getTask(id))?.status, 'done');
    release();
    await tick();
    assert.equal(batches.length, 2);
    const latest = batches[1]!.find(task => task.id === id)!;
    assert.ok(latest.revision > original.revision);
    assert.equal(latest.due_at, due);
    assert.equal(latest.title, 'Уточнить цену');
    assert.equal(latest.status, 'done');
    assert.equal(await repo.telegramPending(device), 0);
    await repo.completeTask(id);
    await tick();
    assert.equal(batches.length, 2);
  } finally { stop(); release(); await running; db.close(); }
});

test('a task signal waits for a running sync and leaves failed uploads durable for foreground retry', async () => {
  const { db, c, repo } = await fixture();
  const device = randomUUID();
  const attempts: RemoteTask[][] = [];
  let active = true, retryAt = 0;
  let release = () => {};
  let running: Promise<unknown> | null = new Promise<void>(resolve => { release = resolve; }).finally(() => { running = null; });
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  function sync() {
    if (running) return running;
    running = (async () => {
      if (retryAt > Date.now()) return;
      const tasks = await repo.telegramOutbox(device, true);
      attempts.push(tasks);
      if (attempts.length === 1) {
        retryAt = Date.now() + 60_000;
        await repo.setSetting('telegram_retry_at', String(retryAt));
        throw new Error('Network unavailable');
      }
      await repo.confirmTelegramUpload(device, tasks);
    })().finally(() => { running = null; });
    return running;
  }
  const stop = observeTelegramTaskChanges(repo, () => active, () => running, sync);
  try {
    const car = await repo.createVehicle({ make: '', model: '', title: 'Лот', note: '' }, null);
    const input = { vehicle_id: car, title: 'Осмотр', due_at: Date.now() + 60_000, status: 'pending' as const, repeat_mode: 'none' as const };
    const id = await repo.saveTask(input);
    const due = input.due_at + 60_000;
    await repo.saveTask({ ...input, due_at: due }, id);
    assert.equal(attempts.length, 0);
    release();
    await tick();
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.find(task => task.id === id)?.due_at, due);
    assert.equal(Number(await repo.getSetting('telegram_retry_at')), retryAt);
    const reopened = new CrmRepository(new Store(c), randomUUID);
    assert.deepEqual(await reopened.telegramOutbox(device, true), attempts[0]);

    await sync();
    assert.equal(attempts.length, 1);
    retryAt = 0;
    await sync();
    assert.deepEqual(attempts[1], attempts[0]);
    assert.equal(await repo.telegramPending(device), 0);

    active = false;
    await repo.completeTask(id);
    await tick();
    assert.equal(attempts.length, 2);
    assert.ok(await reopened.telegramPending(device));
  } finally { stop(); release(); await running?.catch(() => undefined); db.close(); }
});

test('transactional stage promotion rolls back incomplete action and preserves values, and archived tasks stay out of Today', async () => {
  const { db, repo } = await fixture();
  try {
    const car = await repo.createVehicle({ make: '', model: '', phone: '+0 000', note: '' }, null);
    await assert.rejects(repo.promote(car, '400', '500', '', Date.now() + 3600000));
    assert.equal((await repo.getVehicle(car))?.vehicle.buyout_price, '');
    assert.equal((await repo.listTasks(car)).length, 0);
    await repo.promote(car, '400 если без вложений', '500', 'Осмотр', Date.now() + 3600000);
    assert.equal((await repo.getVehicle(car))?.vehicle.status, 'in_progress');
    assert.equal((await repo.listTasks()).length, 1);
    await repo.changeStage(car, 'completed', 'bought');
    assert.equal((await repo.listTasks()).length, 0);
    assert.equal((await repo.listTasks(car)).length, 1);
    await assert.rejects(repo.saveTask({ vehicle_id: car, title: 'Новая', due_at: Date.now() + 3600000, status: 'pending', repeat_mode: 'none' }), /архива/);
    await repo.changeStage(car, 'cold');
    assert.equal((await repo.listTasks()).length, 1);
  } finally { db.close(); }
});

test('a failed native cancellation blocks only the affected task and retries it before replacement', async () => {
  const { db, repo } = await fixture();
  try {
    const car = await repo.createVehicle({ make: '', model: '', title: 'Лот', note: '' }, null);
    const data = { vehicle_id: car, title: 'Осмотр', status: 'pending' as const, repeat_mode: 'none' as const, due_at: Date.now() + 60000 };
    const first = await repo.saveTask(data);
    const old = (await repo.pendingReminders())[0]!.provider_id;
    const other = await repo.saveTask({ ...data, title: 'Звонок' });
    await repo.saveTask({ ...data, due_at: data.due_at + 10000 }, first);
    const target = (await repo.pendingReminders()).find(item => item.task_id === first)!;
    const external = new Set([old]);
    let rejected = true;
    const sync = createReminderReconciler({
      list: async () => [...external],
      cancel: async id => { if (rejected) throw new Error('Android busy'); external.delete(id); },
      schedule: async ({ id }) => { if (id === target.provider_id) assert.ok(!external.has(old)); external.add(id); return id; },
    });
    await sync(repo);
    assert.equal((await repo.pendingReminders()).find(item => item.task_id === other)?.state, 'scheduled');
    assert.ok(!external.has(target.provider_id));
    assert.deepEqual(await repo.cancellations(), [{ provider_id: old, task_id: first }]);
    rejected = false;
    await sync(repo);
    assert.ok(!external.has(old) && external.has(target.provider_id));
    assert.equal(external.size, 2);
  } finally { db.close(); }
});

test('recovering an interrupted import removes only journaled unreferenced copies and retries failed checks', async () => {
  const { db, repo } = await fixture();
  try {
    const kept = randomUUID() + '.png', partial = randomUUID() + '.mp4', uncertain = randomUUID() + '.jpg', unrelated = randomUUID() + '.png';
    await repo.createVehicle({ make: '', model: '', title: 'Лот', note: '' }, { relative_path: kept, mime_type: 'image/png' });
    const files = new Set([kept, partial, partial + '.part', uncertain, unrelated]);
    const markers = new Set([kept, partial, uncertain, '../outside']);
    function remove(path: string, referenced: boolean) {
      if (!referenced) files.delete(path);
      files.delete(path + '.part'); markers.delete(path);
    }
    await recoverMediaCopies([...markers], path => {
      if (path === uncertain) throw new Error('SQLite unavailable');
      return repo.hasMediaPath(path);
    }, remove);
    assert.deepEqual([...files], [kept, uncertain, unrelated]);
    assert.deepEqual([...markers], [uncertain, '../outside']);
    await recoverMediaCopies([...markers], path => repo.hasMediaPath(path), remove);
    assert.deepEqual([...files], [kept, unrelated]);
    assert.deepEqual([...markers], ['../outside']);
  } finally { db.close(); }
});

test('editing car fields and attaching files is atomic; share keeps an existing listing and archives preserve close date', async () => {
  const { db, repo } = await fixture();
  try {
    const initial = { make: '', model: '', title: 'Лот', note: '', sourceUrl: 'https://original.invalid/a' };
    const car = await repo.createVehicle(initial, null);
    await assert.rejects(repo.updateVehicle(car, { ...initial, title: 'Изменение' }, [
      { relative_path: randomUUID() + '.png', mime_type: 'image/png' }, { relative_path: '../invalid', mime_type: 'video/mp4' },
    ]));
    assert.equal((await repo.getVehicle(car))?.vehicle.title, initial.title);
    assert.equal((await repo.getVehicle(car))?.attachments.length, 0);
    const file = randomUUID() + '.mp4';
    await repo.updateVehicle(car, { ...initial, title: 'Изменение' }, [{ relative_path: file, mime_type: 'video/mp4' }]);
    await repo.attachIncoming(car, [], 'Другой источник', 'https://next.invalid/b');
    await repo.changeStage(car, 'completed', 'bought', 'Выкуп подтверждён');
    const archivedAt = (await repo.getVehicle(car))!.vehicle.archived_at;
    assert.ok(archivedAt);
    await repo.changeStage(car, 'completed', 'bought', 'Повтор');
    await repo.updateVehicle(car, { ...initial, title: 'Отредактирован архив' });
    const detail = (await repo.getVehicle(car))!;
    assert.equal(detail.vehicle.archived_at, archivedAt);
    assert.equal(detail.vehicle.source_url, initial.sourceUrl);
    assert.equal(detail.attachments[0]?.relative_path, file);
    assert.deepEqual(detail.notes.map(row => row.body).sort(), ['Выкуп подтверждён', 'Другой источник\nhttps://next.invalid/b'].sort());
    await repo.changeStage(car, 'cold');
    assert.equal((await repo.getVehicle(car))?.vehicle.archived_at, null);
  } finally { db.close(); }
});

test('agenda and active pages stay bounded with 100 and 1000 lots and exclude archived tasks', async t => {
  const { db, c, repo } = await fixture();
  try {
    const now = Date.now(), end = now + 3600000;
    for (const size of [100, 1000]) {
      await c.withTransactionAsync(async () => {
        const start = size === 100 ? 0 : 100;
        for (let i = start; i < size; i++) {
          const id = randomUUID();
          const archived = i % 10 === 0;
          await c.runAsync('INSERT INTO lots(id,title,search_text,status,completion_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', id, 'Машина ' + i, 'машина ' + i, archived ? 'completed' : 'cold', archived ? 'bought' : null, i, i);
          await c.runAsync("INSERT INTO lot_tasks(id,vehicle_id,title,due_at,status,repeat_mode,created_at,updated_at) VALUES(?,?,'Звонок',?,'pending','none',?,?)", randomUUID(), id, i % 2 ? now + i : now - i, i, i);
        }
      });
      const start = performance.now();
      const [page, next, archive, agenda] = await Promise.all([
        repo.listVehicles(0, 50, { query: '  МАШИНА ' }), repo.listVehicles(50, 50, {}),
        repo.listVehicles(0, 50, { archive: true }), repo.agenda(now, end),
      ]);
      t.diagnostic(size + ' fixture lots: first/second page + archive + agenda ' + Math.round(performance.now() - start) + ' ms (desktop SQLite WASM)');
      assert.equal(page.length, 50); assert.equal(next.length, Math.min(50, size * 0.9 - 50));
      assert.equal(new Set([...page, ...next].map(row => row.id)).size, page.length + next.length);
      assert.equal(archive.length, Math.min(50, size / 10));
      assert.equal(agenda.counts.today + agenda.counts.overdue, size * 0.9);
      assert.equal(agenda.today.length, 5); assert.equal(agenda.overdue.length, 5); assert.equal(agenda.later.length, 0);
    }
  } finally { db.close(); }
});

test('completed-task cleanup retains history, active jobs and the next important occurrence', async () => {
  const { db, repo } = await fixture();
  try {
    const car = await repo.createVehicle({ make: '', model: '', title: 'Лот', note: 'Договорились' }, null);
    const input = { vehicle_id: car, title: 'Звонок', due_at: Date.now() + 120000, status: 'pending' as const, repeat_mode: 'daily' as const, important: 1 as const };
    const finished = await repo.saveTask(input);
    const active = await repo.saveTask({ ...input, title: 'Документы' });
    const remote = 'fixture-device';
    await repo.telegramOutbox(remote);
    await repo.completeTask(finished);
    const next = (await repo.listTasks(car)).find(task => task.id !== finished && task.id !== active)!;
    assert.equal(await repo.deleteCompletedTasks([finished, next.id, active]), 1);
    assert.equal(await repo.deleteCompletedTasks([finished]), 0);
    assert.equal(await repo.getTask(finished), null);
    assert.equal((await repo.getTask(next.id))?.important, 1);
    assert.deepEqual(new Set((await repo.pendingReminders()).map(row => row.task_id)), new Set([next.id, active]));
    assert.ok((await repo.getVehicle(car))?.events.some(row => row.kind === 'task_done'));
    assert.equal((await repo.telegramOutbox(remote)).find(row => row.id === finished)?.status, 'done');
    assert.deepEqual(await repo.cancellations().then(rows => rows.map(row => row.task_id)), [finished]);
  } finally { db.close(); }
});

test('archive deletion is transactional and a media failure leaves an idempotent cleanup job', async () => {
  const { db, c, repo } = await fixture();
  try {
    const photo = randomUUID() + '.png', video = randomUUID() + '.mp4', other = randomUUID() + '.png';
    const raw = { make: '', model: '', title: 'Автомобиль', note: 'Заметка' };
    const one = await repo.createVehicle(raw, [{ relative_path: photo, mime_type: 'image/png' }]);
    const two = await repo.createVehicle(raw, [{ relative_path: video, mime_type: 'video/mp4' }]);
    const keep = await repo.createVehicle(raw, [{ relative_path: other, mime_type: 'image/png' }]);
    const task = await repo.saveTask({ vehicle_id: one, title: 'Задача', due_at: Date.now() + 60000, status: 'pending', repeat_mode: 'none' });
    await repo.changeStage(one, 'completed', 'bought'); await repo.changeStage(two, 'completed', 'other');
    await assert.rejects(repo.deleteArchivedVehicles([one, keep]), /архиве/);
    assert.ok(await repo.getTask(task)); assert.deepEqual(await repo.cleanupFiles(), []);
    await c.execAsync("CREATE TRIGGER fail_delete BEFORE DELETE ON lots WHEN OLD.id='" + two + "' BEGIN SELECT RAISE(ABORT,'write failed'); END");
    await assert.rejects(repo.deleteArchivedVehicles([one, two]), /write failed/);
    assert.ok(await repo.getVehicle(one)); assert.deepEqual(await repo.cleanupFiles(), []);
    await c.execAsync('DROP TRIGGER fail_delete');
    assert.deepEqual(await repo.deleteArchivedVehicles([one, two, one]), { vehicles: 2, filesQueued: 2 });
    assert.equal(await repo.getTask(task), null); assert.ok(await repo.getVehicle(keep));
    const privateFiles = new Set([photo, video, other]), galleryOriginal = new Set(['gallery://original']);
    assert.equal(await processMediaCleanup(repo, file => { if (file.relative_path === video) throw new Error('filesystem busy'); privateFiles.delete(file.relative_path); }), 1);
    assert.deepEqual(await repo.cleanupFiles(), [{ relative_path: video }]);
    assert.equal(await processMediaCleanup(repo, file => { privateFiles.delete(file.relative_path); }), 0);
    assert.deepEqual([...privateFiles], [other]); assert.equal(galleryOriginal.size, 1);
    assert.deepEqual(await c.getAllAsync('PRAGMA foreign_key_check'), []);
  } finally { db.close(); }
});

test('cold and archive review jobs are stable, grouped, snoozable and recalculated without backlog alarms', async () => {
  const { db, c, repo } = await fixture();
  try {
    const base = Date.now() - 86400000;
    const car = await repo.createVehicle({ make: '', model: '', title: 'Контакт', note: '' }, null);
    await c.runAsync('UPDATE lots SET created_at=?,last_contact_at=? WHERE id=?', base, base, car);
    const first = (await repo.reminderQueue(true, base)).reminders[0]!;
    assert.equal(first.task_id, 'review:cold'); assert.equal(first.due_at, calendarDaysAfter(base, 7));
    assert.equal((await repo.reminderQueue(true, base + 1)).reminders[0]?.provider_id, first.provider_id);
    assert.equal((await repo.reviews(first.due_at)).cold[0]?.id, car);
    await repo.resolveReview(car, 'cold', 'snooze3', first.due_at);
    const snoozed = await repo.reminderQueue(true, first.due_at);
    assert.equal(snoozed.reminders[0]?.due_at, calendarDaysAfter(first.due_at, 3));
    assert.ok(snoozed.cancellations.some(row => row.provider_id === first.provider_id));
    await repo.setSetting('review_cold_days', '0');
    assert.equal((await repo.reminderQueue(true, base)).reminders.length, 0);
    await repo.changeStage(car, 'completed', 'other');
    const archivedAt = (await repo.getVehicle(car))!.vehicle.archived_at!;
    const archive = (await repo.reminderQueue(true, archivedAt)).reminders[0]!;
    assert.equal(archive.due_at, calendarDaysAfter(archivedAt, 14));
    await repo.resolveReview(car, 'archive', 'keep', archive.due_at);
    assert.equal((await repo.reviews(archive.due_at)).archive.length, 0);
    await repo.changeStage(car, 'cold');
    assert.equal((await repo.reminderQueue(true, Date.now())).reminders.length, 0);
  } finally { db.close(); }
});

test('Android-compatible SQLite: real vehicle/archive queries on fresh, S0, 0.2 and Sprint 2 databases', { skip: process.platform !== 'win32' }, async t => {
  const { nativeSqlite } = await import('./native-sqlite');
  for (const initialVersion of [0, 1, 3, 4]) await t.test(`starting schema ${initialVersion}`, async () => {
    const fixture = await nativeSqlite(); const c = fixture.db; const repo = new CrmRepository(new Store(c), randomUUID);
    try {
      t.diagnostic(`Native regression SQLite ${fixture.version}; sql.js is not used for this query`);
      let id: string;
      if (initialVersion === 1) {
        await migrate(c, [migrations[0]!]); id = randomUUID();
        await c.runAsync('INSERT INTO vehicles(id,make,model,created_at,updated_at) VALUES(?,?,?,?,?)', id, 'Legacy', 'Car', 1, 1);
        await c.runAsync('INSERT INTO notes VALUES(?,?,?,?,?)', randomUUID(), id, 'Сохранить заметку', 1, 1);
        await c.runAsync('INSERT INTO attachments VALUES(?,?,?,?,?,?,?)', randomUUID(), id, `${randomUUID()}.png`, 'image/png', 'Старая фотография', 1, 1);
        await c.runAsync('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)', randomUUID(), id, 'Осмотр', Date.now() + 60000, 'pending', 'none', 1, 1);
        await migrate(c);
      } else if (initialVersion === 0) {
        await migrate(c); id = await repo.createVehicle({ make: '', model: '', title: 'Лот', note: 'Заметка' }, null);
      } else {
        await migrate(c, migrations.slice(0, initialVersion));
        id = randomUUID();
        const noteId = randomUUID(), taskId = randomUUID(), archived = randomUUID(), due = Date.now() + 60000;
        await c.runAsync("INSERT INTO lots(id,title,search_text,created_at,updated_at) VALUES(?,'Лот','лот',1,1)", id);
        await c.runAsync("INSERT INTO lots(id,title,status,completion_reason,created_at,updated_at) VALUES(?,'Архив','completed','bought',1,9)", archived);
        await c.runAsync("INSERT INTO lot_events VALUES(?,?,'stage','Стадия: Завершено / Куплено',7)", randomUUID(), archived);
        await c.runAsync("INSERT INTO lot_notes(id,vehicle_id,body,created_at,updated_at) VALUES(?,?,'Заметка',1,1)", noteId, id);
        await c.runAsync("INSERT INTO lot_tasks(id,vehicle_id,title,due_at,status,repeat_mode,created_at,updated_at) VALUES(?,?,'Осмотр',?,'pending','none',1,1)", taskId, id, due);
        if (initialVersion === 4) await c.runAsync("UPDATE lot_tasks SET description='Проверить колёса' WHERE id=?", taskId);
        const cancellation = randomUUID();
        await c.runAsync('INSERT INTO notification_cancellations VALUES(?)', cancellation);
        assert.equal((await c.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version, initialVersion);
        await migrate(c); await migrate(c);
        assert.equal((await repo.getTask(taskId))?.due_at, due);
        assert.equal((await repo.getTask(taskId))?.description, initialVersion === 4 ? 'Проверить колёса' : '');
        assert.equal((await repo.getVehicle(id))?.notes[0]?.id, noteId);
        assert.equal((await repo.getVehicle(archived))?.vehicle.archived_at, 7);
        assert.deepEqual((await repo.reminderQueue()).cancellations, [{ provider_id: cancellation, task_id: null }]);
        await repo.changeStage(archived, 'cold');
      }
      assert.ok((await c.getAllAsync<{ name: string }>('PRAGMA table_info(lots)')).some(column => column.name === 'cover_id'));
      assert.ok((await repo.listVehicles(0, 50, {})).some(car => car.id === id));
      assert.deepEqual(await repo.listVehicles(0, 50, { archive: true }), []);
      await repo.addMedia(id, [{ relative_path: `${randomUUID()}.png`, mime_type: 'image/png' }, { relative_path: `${randomUUID()}.png`, mime_type: 'image/png' }]);
      const detail = (await repo.getVehicle(id))!, selected = detail.attachments.at(-1)!;
      await repo.setCover(id, selected.id);
      assert.equal((await repo.listVehicles(0, 50, {})).find(car => car.id === id)?.image_path, selected.relative_path);
      const other = await repo.createVehicle({ make: '', model: '', title: 'Другой', note: '' }, { relative_path: `${randomUUID()}.png`, mime_type: 'image/png' });
      const otherMedia = (await repo.getVehicle(other))!.attachments[0]!;
      await c.runAsync('UPDATE lots SET cover_id=? WHERE id=?', otherMedia.id, id);
      assert.ok((await repo.listVehicles(0, 50, { query: initialVersion === 1 ? 'Legacy' : 'Лот' }))[0]?.image_path !== otherMedia.relative_path);
      await repo.setCover(id, selected.id); await repo.changeStage(id, 'completed', 'bought');
      assert.equal((await repo.listVehicles(0, 50, { archive: true }))[0]?.image_path, selected.relative_path);
      await repo.removeMedia(id, selected.id);
      assert.ok((await repo.listVehicles(0, 50, { archive: true }))[0]?.image_path);
      for (const media of (await repo.getVehicle(id))!.attachments) await repo.removeMedia(id, media.id);
      assert.equal((await repo.listVehicles(0, 50, { archive: true }))[0]?.image_path, null);
      await repo.changeStage(id, 'cold');
      assert.ok((await repo.listVehicles(0, 50, {})).some(car => car.id === id));
      assert.ok((await repo.getVehicle(id))!.notes.length);
      if (initialVersion === 1) { assert.equal((await repo.listTasks(id)).length, 1); assert.ok(await c.getFirstAsync('SELECT id FROM vehicles WHERE id=?', id)); }
      assert.deepEqual(await c.getAllAsync('PRAGMA foreign_key_check'), []);
    } finally { await fixture.close(); }
  });
});



test('Showcase backup restores only synthetic rows and merging again is idempotent', async () => {
  const { db, repo } = await fixture();
  try {
    const sample = demoBackup();
    assert.equal(await repo.restoreRows(sample.tables, new Map()), 5);
    assert.equal(await repo.restoreRows(sample.tables, new Map()), 0);
    const restored = await repo.snapshot();
    assert.equal(restored.lot_tasks?.length, 4);
    assert.equal(restored.lot_notes?.length, 5);
    assert.equal(restored.lot_media?.length, 0);
    assert.equal(restored.lots?.filter(row => row.status === 'completed').length, 1);
  } finally { db.close(); }
});
