import { detailFields, isWebUrl, nextRepeatDate, reasonLabels, statusLabels, substatusLabels, validateVehicle, type Attachment, type CompletionReason, type HistoryEvent, type Note, type Task, type Vehicle, type VehicleDetail, type VehicleInput, type VehicleStatus } from '../domain/models';
import { assertManagedPath, imageExtension } from '../services/image-rules';
import { backupColumns, backupPreferenceKeys, isBackupPreference, type BackupPreferences } from '../services/backup-manifest';
import { callTask, reviewKindOf, type Receipt, type RemoteAction, type RemoteTask } from '../services/telegram-protocol';
import type { Connection, Store } from '../storage/store';
import { calendarDaysAfter, reviewDays, reviewSetting, vehicleReviewDue, type ReviewKind } from '../domain/vehicle-review';

export type ManagedImage = Pick<Attachment, 'relative_path' | 'mime_type'> & { byte_size?: number };
export type VehicleSummary = Vehicle & { image_path: string | null; note_preview: string | null; next_task: string | null; next_due: number | null };
export interface VehicleFilter {
  query?: string; lotType?: string; status?: string; substatus?: string; reason?: string; archive?: boolean;
  archivedSince?: number; archivedBefore?: number; reviewAt?: number;
}
export type TaskSummary = Task & { vehicle_title: string; phone: string; vehicle_status: VehicleStatus };
export interface Reminder { task_id: string; provider_id: string; due_at: number; state: string; error: string | null; title: string; vehicle_id: string | null; vehicle_title: string }
export interface NotificationEntry { id: string; provider_id: string; event: string; created_at: number; task_id: string | null; vehicle_id: string | null; title: string | null }
const taskColumns = "t.*,COALESCE(NULLIF(v.title,''),NULLIF(trim(v.make||' '||v.model),''),v.phone) AS vehicle_title,v.phone,v.status AS vehicle_status";
const reminderQuery = `SELECT r.*,t.title,t.vehicle_id,COALESCE(NULLIF(v.title,''),NULLIF(trim(v.make||' '||v.model),''),v.phone) AS vehicle_title
  FROM task_reminders r JOIN lot_tasks t ON t.id=r.task_id JOIN lots v ON v.id=t.vehicle_id WHERE t.status='pending' AND v.status!='completed'`;
const omitPhone = (text: string) => text.replace(/\+?\d(?:[\s().-]*\d){9,14}(?!\d)/g, '[контакт в CRM]');
const telegramName = (car: Pick<Vehicle, 'title' | 'make' | 'model' | 'phone'>) => {
  const title = car.title?.trim() ?? '';
  return omitPhone((title && title !== car.phone && !/^[+\d()\s-]{7,}$/.test(title) ? title : `${car.make} ${car.model}`.trim()) || 'Автомобиль').slice(0, 120);
};

export class CrmRepository {
  constructor(private readonly store: Store, private readonly uuid: () => string) {}
  private listeners = new Set<() => void>();
  private taskListeners = new Set<(operation: number) => void>();
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  notifyChanges(): void { for (const listener of this.listeners) listener(); }
  subscribeTaskChanges(listener: (operation: number) => void): () => void { this.taskListeners.add(listener); return () => { this.taskListeners.delete(listener); }; }
  private notifyTaskChange(operation: number): void {
    if (operation) for (const listener of this.taskListeners) listener(operation);
  }

  private async contact(db: Connection, id: string) {
    await db.runAsync('UPDATE lots SET last_contact_at=?,review_after=NULL WHERE id=?', Date.now(), id);
  }

  reviews(now: number) {
    return this.store.read(async db => {
      const cars = await db.getAllAsync<Vehicle>("SELECT * FROM lots WHERE status IN ('cold','completed')");
      const due = async (kind: ReviewKind) => {
        const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM app_settings WHERE key=?', reviewSetting[kind]);
        const days = reviewDays(kind, row?.value ?? null);
        return cars.filter(car => (vehicleReviewDue(car, kind, days) ?? Infinity) <= now);
      };
      return { cold: await due('cold'), archive: await due('archive') };
    });
  }

  resolveReview(id: string, kind: ReviewKind, action: 'keep' | 'snooze3' | 'snooze7', now = Date.now()) {
    return this.store.write(async db => {
      const car = await db.getFirstAsync<Vehicle>('SELECT * FROM lots WHERE id=?', id);
      const setting = await db.getFirstAsync<{ value: string }>('SELECT value FROM app_settings WHERE key=?', reviewSetting[kind]);
      const days = reviewDays(kind, setting?.value ?? null);
      if (!car || (vehicleReviewDue(car, kind, days) ?? Infinity) > now) throw new Error('Эта проверка уже не актуальна.');
      if (kind === 'cold' && action === 'keep') {
        await db.runAsync('UPDATE lots SET last_contact_at=?,review_after=NULL WHERE id=?', now, id);
      } else {
        const after = calendarDaysAfter(now, action === 'keep' ? days : action === 'snooze3' ? 3 : 7);
        await db.runAsync('UPDATE lots SET review_after=? WHERE id=?', after, id);
      }
    });
  }

  private async deleteTaskRows(db: Connection, ids: string[]) {
    for (const id of ids) {
      await this.reminder(db, id, 0, false);
      await db.runAsync('INSERT OR IGNORE INTO notification_cancellations(provider_id,task_id) SELECT id,task_id FROM reminders WHERE task_id=?', id);
      await db.runAsync('DELETE FROM notification_log WHERE task_id=? OR reminder_id IN (SELECT id FROM reminders WHERE task_id=?)', id, id);
      await db.runAsync('DELETE FROM lot_tasks WHERE id=?', id);
      await db.runAsync('DELETE FROM tasks WHERE id=?', id);
    }
  }

  deleteCompletedTasks(ids: readonly string[]): Promise<number> {
    return this.store.write(async db => {
      const chosen = new Set(ids);
      const done = (await db.getAllAsync<{ id: string }>("SELECT id FROM lot_tasks WHERE status='done'")).filter(row => chosen.has(row.id));
      await this.deleteTaskRows(db, done.map(row => row.id));
      return done.length;
    });
  }

  deleteArchivedVehicles(ids: readonly string[]): Promise<{ vehicles: number; filesQueued: number }> {
    return this.store.write(async db => {
      const chosen = [...new Set(ids)];
      let filesQueued = 0;
      for (const id of chosen) {
        if (!await db.getFirstAsync("SELECT id FROM lots WHERE id=? AND status='completed'", id))
          throw new Error('Удалить можно только карточки, которые сейчас находятся в архиве.');
        const files = await db.getAllAsync<{ relative_path: string }>('SELECT relative_path FROM lot_media WHERE vehicle_id=? UNION SELECT relative_path FROM attachments WHERE vehicle_id=?', id, id);
        const tasks = await db.getAllAsync<{ id: string }>('SELECT id FROM lot_tasks WHERE vehicle_id=? UNION SELECT id FROM tasks WHERE vehicle_id=?', id, id);
        await this.deleteTaskRows(db, tasks.map(task => task.id));
        await db.runAsync('DELETE FROM notification_log WHERE vehicle_id=?', id);
        await db.runAsync('DELETE FROM lot_media WHERE vehicle_id=?', id);
        await db.runAsync('DELETE FROM lot_notes WHERE vehicle_id=?', id);
        await db.runAsync('DELETE FROM lot_events WHERE vehicle_id=?', id);
        await db.runAsync('DELETE FROM lots WHERE id=?', id);
        await db.runAsync('DELETE FROM vehicles WHERE id=?', id);
        for (const file of files) {
          assertManagedPath(file.relative_path);
          const inserted = await db.runAsync('INSERT OR IGNORE INTO media_cleanup VALUES(?)', file.relative_path);
          filesQueued += inserted.changes;
        }
      }
      return { vehicles: chosen.length, filesQueued };
    });
  }

  private async event(db: Connection, id: string, kind: string, body: string) {
    await db.runAsync('INSERT INTO lot_events(id,vehicle_id,kind,body,created_at) VALUES(?,?,?,?,?)', this.uuid(), id, kind, body, Date.now());
    await this.searchIndex(db, id);
  }
  private async searchIndex(db: Connection, id: string) {
    const car = await db.getFirstAsync<Vehicle>('SELECT * FROM lots WHERE id=?', id);
    if (!car) return;
    const bodies = await db.getAllAsync<{ body: string }>('SELECT body FROM lot_notes WHERE vehicle_id=? UNION ALL SELECT body FROM lot_events WHERE vehicle_id=?', id, id);
    await db.runAsync('UPDATE lots SET search_text=? WHERE id=?', [car.title, car.make, car.model, car.seller, car.phone, car.phone.replace(/\D/g, ''), ...bodies.map(n => n.body)].join(' ').toLocaleLowerCase('ru-RU'), id);
  }
  private async metadata(db: Connection, id: string, raw: VehicleInput) {
    const input = validateVehicle(raw);
    await db.runAsync(`UPDATE lots SET make=?,model=?,title=?,source_url=?,lot_type=?,substatus=?,${detailFields.map(k => `${k}=?`).join(',')},updated_at=? WHERE id=?`,
      input.make, input.model, input.title?.trim() || null, input.sourceUrl?.trim() || null, input.lot_type ?? 'regular', input.substatus ?? '',
      ...detailFields.map(k => input[k]?.trim() ?? ''), Date.now(), id);
  }
  createVehicle(raw: VehicleInput, image: ManagedImage | ManagedImage[] | null): Promise<string> {
    const input = validateVehicle(raw);
    const id = this.uuid();
    return this.store.write(async db => {
      const now = Date.now();
      await db.runAsync('INSERT INTO lots(id,created_at,updated_at) VALUES(?,?,?)', id, now, now);
      await this.metadata(db, id, input);
      if (input.note) await db.runAsync('INSERT INTO lot_notes(id,vehicle_id,body,created_at,updated_at) VALUES(?,?,?,?,?)', this.uuid(), id, input.note, now, now);
      await this.insertMedia(db, id, image ? Array.isArray(image) ? image : [image] : []);
      await this.event(db, id, 'created', 'Карточка создана');
      return id;
    });
  }
  listVehicles(offset = 0, limit = 50, filter: VehicleFilter = { lotType: 'regular' }): Promise<VehicleSummary[]> {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Некорректные параметры списка.');
    const clauses = [filter.archive ? "v.status='completed'" : "v.status!='completed'"];
    const values: (string | number)[] = [];
    if (filter.archive && filter.archivedSince !== undefined) { clauses.push('v.archived_at>=?'); values.push(filter.archivedSince); }
    if (filter.archive && filter.archivedBefore !== undefined) { clauses.push('v.archived_at<=?'); values.push(filter.archivedBefore); }
    if (filter.archive && filter.reviewAt !== undefined) { clauses.push('(v.review_after IS NULL OR v.review_after<=?)'); values.push(filter.reviewAt); }
    for (const [key, column] of [['lotType', 'lot_type'], ['status', 'status'], ['substatus', 'substatus'], ['reason', 'completion_reason']] as const) {
      if (filter[key]) { clauses.push(`v.${column}=?`); values.push(filter[key]!); }
    }
    if (filter.query?.trim()) {
      clauses.push('instr(v.search_text,?)>0');
      const query = filter.query.trim().toLocaleLowerCase('ru-RU');
      values.push(/^(?=.*\d)[+\d\s()-]+$/.test(query) ? query.replace(/\D/g, '') : query);
    }
    return this.store.read(db => db.getAllAsync<VehicleSummary>(`SELECT v.*,
      COALESCE(
        (SELECT relative_path FROM lot_media WHERE id=v.cover_id AND vehicle_id=v.id AND mime_type LIKE 'image/%'),
        (SELECT relative_path FROM lot_media WHERE vehicle_id=v.id AND mime_type LIKE 'image/%' ORDER BY created_at,id LIMIT 1)
      ) AS image_path,
      (SELECT body FROM lot_notes WHERE vehicle_id=v.id ORDER BY created_at DESC,id DESC LIMIT 1) AS note_preview,
      (SELECT title FROM lot_tasks WHERE vehicle_id=v.id AND status='pending' ORDER BY due_at,id LIMIT 1) AS next_task,
      (SELECT due_at FROM lot_tasks WHERE vehicle_id=v.id AND status='pending' ORDER BY due_at,id LIMIT 1) AS next_due
      FROM lots v WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`, ...values, limit, offset));
  }
  getVehicle(id: string, order: 'asc' | 'desc' = 'asc'): Promise<VehicleDetail | null> {
    const direction = order === 'desc' ? 'DESC' : 'ASC';
    return this.store.read(async db => {
      const vehicle = await db.getFirstAsync<Vehicle>('SELECT * FROM lots WHERE id=?', id);
      if (!vehicle) return null;
      const notes = await db.getAllAsync<Note>(`SELECT * FROM lot_notes WHERE vehicle_id=? ORDER BY created_at ${direction},id ${direction}`, id);
      const attachments = await db.getAllAsync<Attachment>('SELECT * FROM lot_media WHERE vehicle_id=? ORDER BY created_at,id', id);
      const events = await db.getAllAsync<HistoryEvent>(`SELECT * FROM lot_events WHERE vehicle_id=? ORDER BY created_at ${direction},id ${direction}`, id);
      return { vehicle, notes, attachments, events };
    });
  }
  updateVehicle(id: string, raw: Omit<VehicleInput, 'note'>, media: ManagedImage[] = []): Promise<void> {
    const input = validateVehicle({ ...raw, note: '' });
    return this.store.write(async db => {
      if (!(await db.getFirstAsync('SELECT id FROM lots WHERE id=?', id))) throw new Error('Автомобиль не найден.');
      await this.metadata(db, id, input);
      await this.insertMedia(db, id, media);
      await this.event(db, id, 'edited', 'Данные автомобиля обновлены');
    });
  }
  private async insertMedia(db: Connection, vehicleId: string, items: ManagedImage[]) {
    for (const item of items) {
      assertManagedPath(item.relative_path); imageExtension(item.mime_type);
      await db.runAsync('INSERT INTO lot_media(id,vehicle_id,relative_path,mime_type,byte_size,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
        this.uuid(), vehicleId, item.relative_path, item.mime_type, item.byte_size ?? 0, Date.now(), Date.now());
    }
  }
  addMedia(vehicleId: string, items: ManagedImage[]): Promise<void> {
    return this.store.write(async db => { await this.insertMedia(db, vehicleId, items); await this.event(db, vehicleId, 'media', `Добавлено файлов: ${items.length}`); });
  }
  attachIncoming(vehicleId: string, items: ManagedImage[], note: string, sourceUrl: string): Promise<void> {
    if (sourceUrl && !isWebUrl(sourceUrl)) throw new Error('Допустимы только ссылки http и https.');
    return this.store.write(async db => {
      const car = await db.getFirstAsync<Pick<Vehicle, 'source_url'>>('SELECT source_url FROM lots WHERE id=?', vehicleId);
      if (!car) throw new Error('Автомобиль не найден.');
      const body = [note.trim(), car.source_url && sourceUrl && car.source_url !== sourceUrl && !note.split('\n').includes(sourceUrl) ? sourceUrl : ''].filter(Boolean).join('\n');
      if (body.length > 10000) throw new Error('Переданный текст слишком длинный. Сохраните нужную часть отдельной заметкой.');
      await this.insertMedia(db, vehicleId, items);
      if (body) await db.runAsync('INSERT INTO lot_notes(id,vehicle_id,body,created_at,updated_at) VALUES(?,?,?,?,?)', this.uuid(), vehicleId, body, Date.now(), Date.now());
      await db.runAsync('UPDATE lots SET source_url=?,updated_at=? WHERE id=?', car.source_url || sourceUrl || null, Date.now(), vehicleId);
      await this.event(db, vehicleId, 'share', 'Данные добавлены через «Поделиться»');
    });
  }
  updateAttachmentCaption(id: string, caption: string): Promise<void> {
    if (caption.length > 10000) throw new Error('Подпись слишком длинная.');
    return this.store.write(async db => {
      if ((await db.runAsync('UPDATE lot_media SET caption=?,updated_at=? WHERE id=?', caption.trim(), Date.now(), id)).changes !== 1) throw new Error('Вложение не найдено.');
    });
  }
  setCover(vehicleId: string, attachmentId: string): Promise<void> {
    return this.store.write(async db => {
      if (!(await db.getFirstAsync("SELECT id FROM lot_media WHERE id=? AND vehicle_id=? AND mime_type LIKE 'image/%'", attachmentId, vehicleId))) throw new Error('Выберите фотографию этого автомобиля.');
      await db.runAsync('UPDATE lots SET cover_id=?,updated_at=? WHERE id=?', attachmentId, Date.now(), vehicleId);
    });
  }
  removeMedia(vehicleId: string, attachmentId: string): Promise<void> {
    return this.store.write(async db => {
      const item = await db.getFirstAsync<Attachment>('SELECT * FROM lot_media WHERE id=? AND vehicle_id=?', attachmentId, vehicleId);
      if (!item) throw new Error('Файл не найден.');
      await db.runAsync('UPDATE lots SET cover_id=NULL WHERE id=? AND cover_id=?', vehicleId, attachmentId);
      await db.runAsync('DELETE FROM lot_media WHERE id=?', attachmentId);
      await db.runAsync('DELETE FROM attachments WHERE id=? AND vehicle_id=?', attachmentId, vehicleId);
      await db.runAsync('INSERT OR IGNORE INTO media_cleanup VALUES(?)', item.relative_path);
      await this.event(db, vehicleId, 'media', 'Файл удалён пользователем');
    });
  }
  cleanupFiles(): Promise<{ relative_path: string }[]> { return this.store.read(db => db.getAllAsync('SELECT * FROM media_cleanup')); }
  hasMediaPath(path: string): Promise<boolean> {
    return this.store.read(async db => !!await db.getFirstAsync('SELECT 1 FROM lot_media WHERE relative_path=? UNION ALL SELECT 1 FROM attachments WHERE relative_path=? LIMIT 1', path, path));
  }
  confirmCleanup(path: string): Promise<void> { return this.store.write(async db => { await db.runAsync('DELETE FROM media_cleanup WHERE relative_path=?', path); }); }
  saveNote(vehicleId: string, body: string, noteId = this.uuid()): Promise<string> {
    const text = body.trim();
    if (!text || text.length > 10000) throw new Error('Заметка должна содержать от 1 до 10 000 символов.');
    return this.store.write(async db => {
      const now = Date.now();
      const result = await db.runAsync(`INSERT INTO lot_notes(id,vehicle_id,body,created_at,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at WHERE lot_notes.vehicle_id=excluded.vehicle_id`, noteId, vehicleId, text, now, now);
      if (result.changes !== 1) throw new Error('Заметка принадлежит другому автомобилю.');
      await db.runAsync('UPDATE lots SET updated_at=? WHERE id=?', now, vehicleId);
      await this.contact(db, vehicleId);
      await this.searchIndex(db, vehicleId);
      return noteId;
    });
  }
  private async reminder(db: Connection, taskId: string, due: number, pending: boolean) {
    const previous = await db.getFirstAsync<{ provider_id: string | null }>('SELECT provider_id FROM task_reminders WHERE task_id=?', taskId);
    if (previous?.provider_id) await db.runAsync('INSERT OR IGNORE INTO notification_cancellations(provider_id,task_id) VALUES(?,?)', previous.provider_id, taskId);
    await db.runAsync('DELETE FROM task_reminders WHERE task_id=?', taskId);
    if (pending) await db.runAsync("INSERT INTO task_reminders(task_id,provider_id,due_at,state) VALUES(?,?,?,'pending')", taskId, this.uuid(), due);
  }
  saveTask(input: Pick<Task, 'vehicle_id' | 'title' | 'due_at' | 'status' | 'repeat_mode' | 'important'> & { description?: string }, id = this.uuid(), expectedUpdatedAt?: number, createOnly = false): Promise<string> {
    if (!input.title.trim() || input.title.trim().length > 200 || !Number.isSafeInteger(input.due_at) || input.due_at < 0 || !Number.isFinite(new Date(input.due_at).getTime()) || !['none', 'daily', 'weekly'].includes(input.repeat_mode)) throw new Error('Укажите действие и корректное время задачи.');
    return this.store.write(async db => {
      const current = await db.getFirstAsync<Task>('SELECT * FROM lot_tasks WHERE id=?', id);
      const title = input.title.trim(), description = input.description?.trim() ?? current?.description ?? '';
      const important = input.important ?? current?.important ?? 0;
      if (description.length > 2000) throw new Error('Описание должно быть не длиннее 2 000 символов.');
      if (current && current.vehicle_id !== input.vehicle_id) throw new Error('Задача принадлежит другому автомобилю.');
      if (current && createOnly) {
        if (current.title === title && current.due_at === input.due_at && current.repeat_mode === input.repeat_mode && current.description === description && current.important === important) return 0;
        throw new Error('Эта задача уже создана. Откройте её из списка.');
      }
      const now = Math.max(Date.now(), (current?.updated_at ?? 0) + 1);
      if (expectedUpdatedAt !== undefined) {
        if (!current || current.updated_at !== expectedUpdatedAt) throw new Error('Задача уже изменилась. Ваш черновик открыт; вернитесь к списку и откройте актуальную задачу.');
      }
      const car = await db.getFirstAsync<Vehicle>('SELECT * FROM lots WHERE id=?', input.vehicle_id);
      if (car?.status === 'completed' && input.status === 'pending') throw new Error('Сначала верните автомобиль из архива.');
      if (current?.title === title && current.description === description && current.due_at === input.due_at && current.status === input.status && current.repeat_mode === input.repeat_mode && current.important === important) return 0;
      const result = await db.runAsync(`INSERT INTO lot_tasks(id,vehicle_id,title,due_at,status,repeat_mode,created_at,updated_at,completed_at,description,important)
        VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,due_at=excluded.due_at,status=excluded.status,
        repeat_mode=excluded.repeat_mode,updated_at=excluded.updated_at,completed_at=excluded.completed_at,description=excluded.description,important=excluded.important WHERE lot_tasks.vehicle_id=excluded.vehicle_id`,
        id, input.vehicle_id, title, input.due_at, input.status, input.repeat_mode, now, now, input.status === 'done' ? current?.completed_at ?? now : null, description, important);
      if (result.changes !== 1) throw new Error('Задача принадлежит другому автомобилю.');
      if (!current || current.title !== title || current.due_at !== input.due_at || current.status !== input.status)
        await this.reminder(db, id, input.due_at, input.status === 'pending');
      const label = !current ? 'Новая задача' : current.due_at !== input.due_at ? 'Задача перенесена' : 'Задача изменена';
      if (!current || current.due_at !== input.due_at) await this.contact(db, input.vehicle_id);
      await this.event(db, input.vehicle_id, 'task', `${label}: ${title}`);
      return !current ? 1 : current.due_at !== input.due_at ? 3 : 2;
    }).then(operation => { this.notifyTaskChange(operation); return id; });
  }
  completeTask(id: string): Promise<void> {
    return this.store.write(async db => {
      const task = await db.getFirstAsync<Task & { vehicle_status: VehicleStatus }>('SELECT t.*,v.status AS vehicle_status FROM lot_tasks t JOIN lots v ON v.id=t.vehicle_id WHERE t.id=?', id);
      if (!task) throw new Error('Задача не найдена.');
      if (task.status === 'done') return 0;
      if (task.vehicle_status === 'completed') throw new Error('Сначала верните автомобиль из архива.');
      await this.completeInside(db, task);
      return 4;
    }).then(changed => this.notifyTaskChange(changed));
  }
  reopenTask(id: string, expectedUpdatedAt: number): Promise<void> {
    return this.store.write(async db => {
      const task = await db.getFirstAsync<Task & { vehicle_status: VehicleStatus }>(
        'SELECT t.*,v.status AS vehicle_status FROM lot_tasks t JOIN lots v ON v.id=t.vehicle_id WHERE t.id=?', id);
      if (!task || task.updated_at !== expectedUpdatedAt || task.status !== 'done') {
        throw new Error('Задача уже изменилась. Откройте её заново.');
      }
      if (task.vehicle_status === 'completed') throw new Error('Сначала верните автомобиль из архива.');
      const now = Date.now();
      // Completion has already created the next recurring occurrence.
      await db.runAsync("UPDATE lot_tasks SET status='pending',completed_at=NULL,updated_at=?,repeat_mode='none' WHERE id=?",
        Math.max(now, task.updated_at + 1), id);
      await this.reminder(db, id, task.due_at, task.due_at > now);
      await this.event(db, task.vehicle_id, 'task', `Задача возвращена в активные: ${task.title}`);
      return 5;
    }).then(operation => this.notifyTaskChange(operation));
  }
  private async completeInside(db: Connection, task: Task) {
      const now = Math.max(Date.now(), task.updated_at + 1);
      await db.runAsync("UPDATE lot_tasks SET status='done',completed_at=?,updated_at=? WHERE id=?", now, now, task.id);
      await this.reminder(db, task.id, task.due_at, false);
      await this.contact(db, task.vehicle_id);
      await this.event(db, task.vehicle_id, 'task_done', `Выполнено: ${task.title}`);
      if (task.repeat_mode !== 'none') {
        const next = this.uuid(); const due = nextRepeatDate(task.due_at, task.repeat_mode, now);
        await db.runAsync("INSERT INTO lot_tasks(id,vehicle_id,title,due_at,status,repeat_mode,created_at,updated_at,description,important) VALUES(?,?,?,?,'pending',?,?,?,?,?)", next, task.vehicle_id, task.title, due, task.repeat_mode, now, now, task.description, task.important ?? 0);
        await this.reminder(db, next, due, true);
      }
  }
  listTasks(vehicleId?: string): Promise<TaskSummary[]> {
    return this.store.read(db => db.getAllAsync<TaskSummary>(`SELECT ${taskColumns}
      FROM lot_tasks t JOIN lots v ON v.id=t.vehicle_id ${vehicleId ? 'WHERE t.vehicle_id=?' : "WHERE v.status!='completed' OR t.status='done'"} ORDER BY t.due_at,t.id`, ...(vehicleId ? [vehicleId] : [])));
  }
  agenda(now: number, end: number) {
    return this.store.read(async db => {
      const source = "FROM lot_tasks t JOIN lots v ON v.id=t.vehicle_id WHERE t.status='pending' AND v.status!='completed'";
      const read = (condition: string, ...times: number[]) => db.getAllAsync<TaskSummary>(`SELECT ${taskColumns} ${source} AND ${condition} ORDER BY t.due_at,t.id LIMIT 5`, ...times);
      const counts = await db.getFirstAsync<{ overdue: number; today: number }>(`SELECT COALESCE(SUM(t.due_at<?),0) AS overdue,COALESCE(SUM(t.due_at>=?),0) AS today ${source} AND t.due_at<?`, now, now, end);
      return { overdue: await read('t.due_at<?', now), today: await read('t.due_at>=? AND t.due_at<?', now, end),
        later: await read('t.due_at>=?', end), counts: counts! };
    });
  }
  getTask(id: string): Promise<TaskSummary | null> {
    return this.store.read(db => db.getFirstAsync<TaskSummary>(`SELECT ${taskColumns}
      FROM lot_tasks t JOIN lots v ON v.id=t.vehicle_id WHERE t.id=?`, id));
  }
  changeStage(id: string, status: VehicleStatus, reason: CompletionReason | null = null, comment = ''): Promise<void> {
    const note = comment.trim();
    if (note.length > 10000) throw new Error('Комментарий слишком длинный.');
    return this.store.write(async db => {
      const car = await db.getFirstAsync<Vehicle>('SELECT * FROM lots WHERE id=?', id);
      if (!car) throw new Error('Автомобиль не найден.');
      await this.changeStageInside(db, car, status, reason, note);
    });
  }
  private async changeStageInside(db: Connection, car: Vehicle, status: VehicleStatus, reason: CompletionReason | null, note = '') {
      const { id } = car;
      if (car.status === status && car.completion_reason === (status === 'completed' ? reason : null)) return;
      if (status === 'in_progress') {
        const action = await db.getFirstAsync("SELECT id FROM lot_tasks WHERE vehicle_id=? AND status='pending' LIMIT 1", id);
        const missing = [!car.buyout_price && 'оценка выкупа', !car.market_price && 'рыночная оценка', !action && 'следующее действие'].filter(Boolean);
        if (missing.length) throw new Error(`Для стадии «В работе» заполните: ${missing.join(', ')}.`);
      }
      const now = Date.now();
      await db.runAsync('UPDATE lots SET status=?,completion_reason=?,archived_at=?,updated_at=? WHERE id=?', status, status === 'completed' ? reason : null,
        status === 'completed' ? car.archived_at ?? now : null, now, id);
      if (car.status !== status) await this.contact(db, id);
      if (status === 'completed') {
        const pending = await db.getAllAsync<Task>("SELECT * FROM lot_tasks WHERE vehicle_id=? AND status='pending'", id);
        for (const task of pending) await this.reminder(db, task.id, task.due_at, false);
      } else if (car.status === 'completed') {
        const pending = await db.getAllAsync<Task>("SELECT * FROM lot_tasks WHERE vehicle_id=? AND status='pending'", id);
        for (const task of pending) await this.reminder(db, task.id, task.due_at, true);
      }
      if (status === 'completed' && note) await db.runAsync('INSERT INTO lot_notes(id,vehicle_id,body,created_at,updated_at) VALUES(?,?,?,?,?)', this.uuid(), id, note, now, now);
      await this.event(db, id, 'stage', `Стадия: ${statusLabels[status]}${reason ? ` / ${reasonLabels[reason]}` : ''}`);
  }
  promote(id: string, buyout: string, market: string, action: string, due: number): Promise<void> {
    if (!buyout.trim() || !market.trim() || buyout.length > 2000 || market.length > 2000) throw new Error('Заполните оценку выкупа и рыночную оценку.');
    return this.store.write(async db => {
      const car = await db.getFirstAsync<Vehicle>('SELECT * FROM lots WHERE id=?', id);
      if (!car) throw new Error('Автомобиль не найден.');
      if (car.status === 'completed') throw new Error('Сначала верните автомобиль из архива.');
      const pending = await db.getFirstAsync("SELECT id FROM lot_tasks WHERE vehicle_id=? AND status='pending'", id);
      if (pending && car.status === 'in_progress' && car.buyout_price === buyout.trim() && car.market_price === market.trim()) return 0;
      if (!pending) {
        if (!action.trim() || action.length > 200 || !Number.isSafeInteger(due) || due <= Date.now()) throw new Error('Укажите следующее действие и будущее время.');
        const taskId = this.uuid(), now = Date.now();
        await db.runAsync("INSERT INTO lot_tasks(id,vehicle_id,title,due_at,status,repeat_mode,created_at,updated_at) VALUES(?,?,?,?,'pending','none',?,?)", taskId, id, action.trim(), due, now, now);
        await this.reminder(db, taskId, due, true);
        await this.event(db, id, 'task', `Задача: ${action.trim()}`);
      }
      const result = await db.runAsync("UPDATE lots SET buyout_price=?,market_price=?,status='in_progress',completion_reason=NULL,updated_at=? WHERE id=?", buyout.trim(), market.trim(), Date.now(), id);
      if (result.changes !== 1) throw new Error('Автомобиль не найден.');
      await this.event(db, id, 'stage', 'Стадия: осмотр / в работе');
      return pending ? 0 : 1;
    }).then(changed => this.notifyTaskChange(changed));
  }
  pendingReminders(): Promise<Reminder[]> { return this.store.read(db => db.getAllAsync<Reminder>(reminderQuery)); }
  cancellations(): Promise<{ provider_id: string; task_id: string | null }[]> {
    return this.store.read(db => db.getAllAsync('SELECT provider_id,task_id FROM notification_cancellations'));
  }
  private async reviewReminderRows(db: Connection, now: number): Promise<Reminder[]> {
    const cars = await db.getAllAsync<Vehicle>("SELECT id,status,created_at,archived_at,last_contact_at,review_after FROM lots WHERE status IN ('cold','completed')");
    for (const kind of ['cold', 'archive'] as const) {
      const setting = await db.getFirstAsync<{ value: string }>('SELECT value FROM app_settings WHERE key=?', reviewSetting[kind]);
      const days = reviewDays(kind, setting?.value ?? null);
      const times = cars.map(car => vehicleReviewDue(car, kind, days)).filter((due): due is number => due !== null);
      const old = await db.getFirstAsync<{ provider_id: string; due_at: number }>('SELECT provider_id,due_at FROM review_reminders WHERE kind=?', kind);
      const past = times.some(due => due <= now);
      // Keep an existing due signal while Android may still deliver it. On first launch,
      // surface historical checks in-app instead of issuing overdue notifications.
      if (old && past && old.due_at <= now && times.includes(old.due_at)) continue;
      const next = past ? Infinity : times.reduce((min, due) => Math.min(min, due), Infinity);
      if (old?.due_at === next) continue;
      if (old) {
        await db.runAsync('INSERT OR IGNORE INTO notification_cancellations(provider_id,task_id) VALUES(?,?)', old.provider_id, `review:${kind}`);
        await db.runAsync('DELETE FROM review_reminders WHERE kind=?', kind);
      }
      if (Number.isFinite(next)) await db.runAsync('INSERT INTO review_reminders(kind,provider_id,due_at) VALUES(?,?,?)', kind, `review-${kind}:${this.uuid()}`, next);
    }
    return db.getAllAsync<Reminder>(`SELECT 'review:'||kind AS task_id,provider_id,due_at,state,error,NULL AS vehicle_id,
      CASE kind WHEN 'cold' THEN 'Проверьте актуальность автомобилей' ELSE 'Проверьте старые карточки в архиве' END AS title,
      'Откройте Auto CRM, чтобы посмотреть список.' AS vehicle_title FROM review_reminders`);
  }
  reminderQueue(includeReviews = false, now = Date.now()) {
    const load = async (db: Connection) => {
      const reviews = includeReviews ? await this.reviewReminderRows(db, now) : [];
      return {
        cancellations: await db.getAllAsync<{ provider_id: string; task_id: string | null }>('SELECT * FROM notification_cancellations'),
        reminders: [...await db.getAllAsync<Reminder>(reminderQuery), ...reviews],
      };
    };
    return includeReviews ? this.store.write(load) : this.store.read(load);
  }
  confirmCancellation(id: string): Promise<void> { return this.store.write(async db => { await db.runAsync('DELETE FROM notification_cancellations WHERE provider_id=?', id); }); }
  rescheduleAllReminders(preference?: { key: 'notification_sound' | 'notification_vibration' | 'notification_exact'; value: string }): Promise<void> {
    return this.store.write(async db => {
      if (preference) await db.runAsync('INSERT INTO app_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', preference.key, preference.value);
      const tasks = await db.getAllAsync<Task>("SELECT t.* FROM lot_tasks t JOIN lots v ON v.id=t.vehicle_id WHERE t.status='pending' AND v.status!='completed'");
      const now = Date.now();
      for (const task of tasks) {
        if (preference?.key === 'notification_exact' && task.due_at <= now) continue;
        await this.reminder(db, task.id, task.due_at, true);
      }
    });
  }
  reminderResult(id: string, error: string | null): Promise<boolean> {
    const table = id.startsWith('review-') ? 'review_reminders' : 'task_reminders';
    return this.store.write(async db => (await db.runAsync(`UPDATE ${table} SET state=?,error=? WHERE provider_id=?`, error ? 'error' : 'scheduled', error, id)).changes === 1);
  }
  recordNotification(provider: string, providerId: string, event: 'scheduled' | 'received' | 'opened' | 'cancelled', taskId?: string, vehicleId?: string): Promise<void> {
    return this.store.write(async db => {
      if ((event === 'scheduled' || event === 'cancelled') && await db.getFirstAsync('SELECT 1 FROM notification_log WHERE provider=? AND provider_id=? AND event=?', provider, providerId, event)) return;
      await db.runAsync('INSERT INTO notification_log(id,provider,provider_id,event,created_at,task_id,vehicle_id) VALUES(?,?,?,?,?,?,?)', this.uuid(), provider, providerId, event, Date.now(), taskId ?? null, vehicleId ?? null);
    });
  }
  notificationLog(): Promise<NotificationEntry[]> { return this.store.read(db => db.getAllAsync(`SELECT n.*,t.title FROM notification_log n LEFT JOIN lot_tasks t ON t.id=n.task_id ORDER BY n.created_at DESC LIMIT 300`)); }
  getSetting(key: string): Promise<string | null> { return this.store.read(async db => (await db.getFirstAsync<{ value: string }>('SELECT value FROM app_settings WHERE key=?', key))?.value ?? null); }
  setSetting(key: string, value: string): Promise<void> { return this.setSettings({ [key]: value }); }
  setSettings(settings: Record<string, string>): Promise<void> {
    return this.store.write(async db => {
      for (const [key, value] of Object.entries(settings)) await db.runAsync('INSERT INTO app_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);
    });
  }
  dashboard(): Promise<{ active: number; inspections: number; completed: number }> {
    return this.store.read(async db => (await db.getFirstAsync<{ active: number; inspections: number; completed: number }>(`SELECT
      COALESCE(SUM(status!='completed'),0) AS active,COALESCE(SUM(status='in_progress'),0) AS inspections,COALESCE(SUM(status='completed'),0) AS completed FROM lots`))!);
  }
  plannedInspections(): Promise<Vehicle[]> {
    return this.store.read(db => db.getAllAsync<Vehicle>("SELECT * FROM lots WHERE inspection_at!='' AND status!='completed' ORDER BY updated_at DESC LIMIT 30"));
  }
  telegramOutbox(deviceId: string, includeReviews = false): Promise<RemoteTask[]> {
    return this.store.write(async db => {
      type Sent = { task_id: string; remote_revision: number; local_revision: number; payload: string; uploaded: number };
      const sent = await db.getAllAsync<Sent>('SELECT * FROM telegram_sent WHERE device_id=?', deviceId);
      const previous = new Map(sent.map(row => [row.task_id, row]));
      const tasks = await db.getAllAsync<Task & Pick<Vehicle,'make'|'model'|'phone'|'substatus'> & { vehicle_status: VehicleStatus; car_title: string | null }>(`SELECT t.*,v.status AS vehicle_status,v.title AS car_title,v.make,v.model,v.phone,v.substatus FROM lot_tasks t JOIN lots v ON v.id=t.vehicle_id
        WHERE (t.status='pending' AND v.status!='completed') OR EXISTS(SELECT 1 FROM telegram_sent s WHERE s.device_id=? AND s.task_id=t.id)`, deviceId);
      const records = tasks.map(task => ({ local: task.updated_at, payload: {
        id: task.id, title: omitPhone(task.title).slice(0, 200), due_at: task.due_at, status: task.vehicle_status === 'completed' ? 'done' : task.status,
        vehicle_id: task.vehicle_id, vehicle: telegramName({ ...task, title: task.car_title }),
        stage: [statusLabels[task.vehicle_status], task.substatus && substatusLabels[task.substatus]].filter(Boolean).join(' · '), call: callTask(task.title),
      } satisfies Omit<RemoteTask,'revision'> }));
      const reviews: { local: number; payload: Omit<RemoteTask,'revision'> }[] = [];
      if (includeReviews) {
        const days = await this.telegramReviewDays(db);
        const cars = await db.getAllAsync<Vehicle & { has_action: number }>(`SELECT v.*,EXISTS(SELECT 1 FROM lot_tasks t WHERE t.vehicle_id=v.id AND t.status='pending') AS has_action
          FROM lots v WHERE v.status IN ('cold','completed')`);
        for (const car of cars) {
          const kind = car.status === 'cold' ? 'cold' : 'archive';
          const due = vehicleReviewDue(car, kind, days[kind]);
          if (due === null) continue;
          reviews.push({ local: car.updated_at, payload: { id: `${kind}:${car.id}`, title: kind === 'cold' ? 'Проверить актуальность' : 'Проверить архив',
            due_at: due, status: 'pending', vehicle_id: car.id, vehicle: telegramName(car), since: (kind === 'cold' ? car.last_contact_at : car.archived_at) ?? car.created_at,
            promotable: kind === 'cold' && !!car.buyout_price && !!car.market_price && !!car.has_action } });
        }
      }
      const projection = [...records, ...reviews];
      let revision = Number((await db.getFirstAsync<{ value: string }>('SELECT value FROM app_settings WHERE key=?', `telegram_revision:${deviceId}`))?.value ?? 0);
      const currentIds = new Set(projection.map(row => row.payload.id));
      for (const old of sent) {
        if (currentIds.has(old.task_id) || old.local_revision === -1 || (!includeReviews && reviewKindOf(old.task_id))) continue;
        revision = Math.max(Date.now(), revision + 1);
        const payload = JSON.stringify({ id: old.task_id, title: 'Удалённая задача', due_at: 0, status: 'done' });
        await db.runAsync('UPDATE telegram_sent SET remote_revision=?,local_revision=-1,payload=?,uploaded=0 WHERE device_id=? AND task_id=?', revision, payload, deviceId, old.task_id);
      }
      for (const { local, payload: data } of projection) {
        const payload = JSON.stringify(data);
        const old = previous.get(data.id);
        if (old?.payload === payload && old.local_revision === local) continue;
        revision = Math.max(Date.now(), revision + 1);
        await db.runAsync(`INSERT INTO telegram_sent VALUES(?,?,?,?,?,0) ON CONFLICT(device_id,task_id) DO UPDATE SET
          remote_revision=excluded.remote_revision,local_revision=excluded.local_revision,payload=excluded.payload,uploaded=0`, deviceId, data.id, revision, local, payload);
      }
      await db.runAsync('INSERT INTO app_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', `telegram_revision:${deviceId}`, String(revision));
      if (includeReviews) await db.runAsync(`INSERT INTO app_settings(key,value) SELECT ?,CAST(generation AS TEXT) FROM telegram_generation WHERE id=1
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`, `telegram_snapshot:${deviceId}`);
      const rows = await db.getAllAsync<Sent>('SELECT * FROM telegram_sent WHERE device_id=? AND uploaded=0 ORDER BY remote_revision LIMIT 40', deviceId);
      return rows.map(row => ({ ...JSON.parse(row.payload) as Omit<RemoteTask, 'revision'>, revision: row.remote_revision }));
    });
  }
  private async telegramReviewDays(db: Connection) {
    const rows = await db.getAllAsync<{ key: string; value: string }>('SELECT key,value FROM app_settings WHERE key IN (?,?)', reviewSetting.cold, reviewSetting.archive);
    return { cold: reviewDays('cold', rows.find(r => r.key === reviewSetting.cold)?.value ?? null),
      archive: reviewDays('archive', rows.find(r => r.key === reviewSetting.archive)?.value ?? null) };
  }
  telegramReceipts(deviceId: string, seq: number): Promise<Receipt[]> {
    return this.store.read(db => db.getAllAsync<Receipt>('SELECT seq,state FROM telegram_receipts WHERE device_id=? AND seq<=? ORDER BY seq DESC LIMIT 100', deviceId, seq));
  }
  telegramPending(deviceId: string): Promise<number> {
    return this.store.read(async db => (await db.getFirstAsync<{ count: number }>(`SELECT
      (SELECT COUNT(*) FROM telegram_sent WHERE device_id=? AND uploaded=0)
      + EXISTS(SELECT 1 FROM telegram_generation WHERE CAST(generation AS TEXT)!=COALESCE((SELECT value FROM app_settings WHERE key=?),''))
      + EXISTS(SELECT 1 FROM app_settings WHERE key=? AND value!='') AS count`, deviceId, `telegram_snapshot:${deviceId}`, `telegram_ack:${deviceId}`))?.count ?? 0);
  }
  private async applyTelegramReview(db: Connection, action: RemoteAction, kind: ReviewKind, snapshot: RemoteTask, local: number) {
    const id = action.task_id.split(':')[1]!;
    const car = await db.getFirstAsync<Vehicle>('SELECT * FROM lots WHERE id=?', id);
    const days = (await this.telegramReviewDays(db))[kind];
    const now = Date.now();
    if (!car || car.updated_at !== local || vehicleReviewDue(car, kind, days) !== snapshot.due_at || snapshot.due_at > now) return false;
    if (action.action === 'keep' && kind === 'cold') await this.contact(db, id);
    else if (action.action === 'keep' || action.action === 'later') {
      await db.runAsync('UPDATE lots SET review_after=? WHERE id=?', action.action === 'keep' ? calendarDaysAfter(now, days) : action.due_at, id);
    } else if (action.action === 'restore') await this.changeStageInside(db, car, 'cold', null);
    else if (action.action === 'archive' && action.value && Object.hasOwn(reasonLabels, action.value)) {
      await this.changeStageInside(db, car, 'completed', action.value as CompletionReason);
    } else if (action.action === 'promote') {
      const pending = await db.getFirstAsync("SELECT id FROM lot_tasks WHERE vehicle_id=? AND status='pending' LIMIT 1", id);
      if (!pending || !car.buyout_price || !car.market_price) return false;
      await this.changeStageInside(db, car, 'in_progress', null);
    } else return false;
    return true;
  }
  confirmTelegramUpload(deviceId: string, tasks: RemoteTask[]): Promise<void> {
    return this.store.write(async db => { for (const task of tasks) await db.runAsync('UPDATE telegram_sent SET uploaded=1 WHERE device_id=? AND task_id=? AND remote_revision=?', deviceId, task.id, task.revision); });
  }
  applyTelegramActions(deviceId: string, actions: RemoteAction[]): Promise<number> {
    return this.store.write(async db => {
      const cursorKey = `telegram_cursor:${deviceId}`;
      const cursor = Number((await db.getFirstAsync<{ value: string }>('SELECT value FROM app_settings WHERE key=?', cursorKey))?.value ?? 0);
      const fresh = actions.filter(action => action.seq > cursor);
      if (!fresh.length) return 0;
      let conflicts = 0;
      for (const action of fresh) {
        const kind = reviewKindOf(action.task_id);
        const sent = await db.getFirstAsync<{ local_revision: number; remote_revision: number; payload: string }>('SELECT * FROM telegram_sent WHERE device_id=? AND task_id=?', deviceId, action.task_id);
        let applied = false;
        if (sent && kind && sent.remote_revision === action.revision) {
          applied = await this.applyTelegramReview(db, action, kind, JSON.parse(sent.payload) as RemoteTask, sent.local_revision);
        } else if (sent && !kind) {
          const task = await db.getFirstAsync<Task>("SELECT t.* FROM lot_tasks t JOIN lots v ON v.id=t.vehicle_id WHERE t.id=? AND v.status!='completed'", action.task_id);
          if (task && action.action === 'note' && task.status === 'done' && callTask(task.title) && action.value) {
            const now = Date.now();
            await db.runAsync('INSERT INTO lot_notes(id,vehicle_id,body,created_at,updated_at) VALUES(?,?,?,?,?)', this.uuid(), task.vehicle_id, action.value.trim(), now, now);
            await this.contact(db, task.vehicle_id);
            await this.searchIndex(db, task.vehicle_id);
            applied = true;
          } else if (task && sent.remote_revision === action.revision && task.updated_at === sent.local_revision && task.status === 'pending') {
            if (action.action === 'done') { await this.completeInside(db, task); applied = true; }
            else if (action.action === 'snooze' && action.due_at !== null) {
              await db.runAsync('UPDATE lot_tasks SET due_at=?,updated_at=? WHERE id=?', action.due_at, Math.max(Date.now(), task.updated_at + 1), task.id);
              await this.reminder(db, task.id, action.due_at, true);
              await this.event(db, task.vehicle_id, 'telegram', 'Задача перенесена в Telegram');
              applied = true;
            }
          }
        }
        if (!applied) {
          conflicts++;
          if (action.action !== 'note') await db.runAsync('UPDATE telegram_sent SET local_revision=-2,uploaded=0 WHERE device_id=? AND task_id=?', deviceId, action.task_id);
        }
        await db.runAsync('INSERT INTO telegram_receipts VALUES(?,?,?,?,?)', deviceId, action.seq, action.task_id, applied ? 'applied' : 'conflict', Date.now());
      }
      const maximum = Math.max(...fresh.map(action => action.seq));
      for (const [key, value] of [[cursorKey, String(maximum)], [`telegram_ack:${deviceId}`, String(maximum)]] as const)
        await db.runAsync('INSERT INTO app_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);
      return conflicts;
    });
  }
  snapshot(): Promise<Record<string, Record<string, unknown>[]>> {
    return this.store.read(async db => {
      const result: Record<string, Record<string, unknown>[]> = {};
      for (const table of ['lots', 'lot_notes', 'lot_media', 'lot_tasks', 'lot_events']) result[table] = await db.getAllAsync(`SELECT * FROM ${table}`);
      return result;
    });
  }
  existingVehicleIds(): Promise<string[]> {
    return this.store.read(async db => (await db.getAllAsync<{ id: string }>('SELECT id FROM lots')).map(row => row.id));
  }
  restoreRows(tables: Record<string, Record<string, unknown>[]>, paths: Map<string, string>, preferences: BackupPreferences = {}): Promise<number> {
    return this.store.write(async db => {
      const fresh = new Set<string>();
      for (const row of tables.lots ?? []) {
        if (!(await db.getFirstAsync('SELECT id FROM lots WHERE id=?', String(row.id)))) fresh.add(String(row.id));
      }
      for (const table of ['lots', 'lot_notes', 'lot_media', 'lot_tasks', 'lot_events']) for (const original of tables[table] ?? []) {
        const row = { ...original };
        if (!fresh.has(String(table === 'lots' ? row.id : row.vehicle_id))) continue;
        if (table === 'lots' && !Object.hasOwn(row, 'archived_at')) row.archived_at = null;
        if (table === 'lots' && !Object.hasOwn(row, 'last_contact_at')) row.last_contact_at = null;
        if (table === 'lots' && !Object.hasOwn(row, 'review_after')) row.review_after = null;
        if (table === 'lot_tasks' && !Object.hasOwn(row, 'description')) row.description = '';
        if (table === 'lot_tasks' && !Object.hasOwn(row, 'important')) row.important = 0;
        if (table === 'lot_media') { const path = paths.get(String(row.relative_path)); if (!path) throw new Error('В резервной копии отсутствует файл.'); row.relative_path = path; }
        const keys = backupColumns[table]!;
        if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key))) throw new Error('Некорректные поля резервной копии.');
        // Keys are restricted by the validated backup manifest, never accepted as raw SQL.
        await db.runAsync(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(k => row[k] as string | number | null));
      }
      for (const id of fresh) {
        await db.runAsync(`UPDATE lots SET archived_at=(SELECT MAX(created_at) FROM lot_events
          WHERE vehicle_id=? AND kind='stage' AND body LIKE 'Стадия: Завершено%')
          WHERE id=? AND status='completed' AND archived_at IS NULL`, id, id);
        await this.searchIndex(db, id);
        const tasks = await db.getAllAsync<Task>("SELECT t.* FROM lot_tasks t JOIN lots v ON v.id=t.vehicle_id WHERE t.vehicle_id=? AND t.status='pending' AND v.status!='completed'", id);
        for (const task of tasks) await this.reminder(db, task.id, task.due_at, true);
      }
      for (const key of backupPreferenceKeys) {
        const value = preferences[key];
        if (isBackupPreference(key, value)) await db.runAsync('INSERT OR IGNORE INTO app_settings VALUES(?,?)', key, value);
      }
      return fresh.size;
    });
  }
}
