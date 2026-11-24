import type { Connection } from './store';

// Append migrations; never edit an already shipped migration or reset user_version.
export const migrations: readonly string[] = [
  `CREATE TABLE vehicles (
    id TEXT PRIMARY KEY NOT NULL,
    lot_type TEXT NOT NULL DEFAULT 'regular' CHECK(lot_type IN ('regular','corporate')),
    status TEXT NOT NULL DEFAULT 'cold' CHECK(status IN ('cold','in_progress','completed')),
    completion_reason TEXT CHECK(completion_reason IN ('bought','sold_elsewhere','declined','other')),
    make TEXT NOT NULL CHECK(length(trim(make)) BETWEEN 1 AND 100),
    model TEXT NOT NULL CHECK(length(trim(model)) BETWEEN 1 AND 100),
    title TEXT, source_url TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    CHECK((status = 'completed' AND completion_reason IS NOT NULL) OR
          (status != 'completed' AND completion_reason IS NULL))
  );
  CREATE INDEX vehicles_list ON vehicles(lot_type, status, created_at DESC, id DESC);
  CREATE INDEX vehicles_name ON vehicles(make COLLATE NOCASE, model COLLATE NOCASE);
  CREATE TABLE notes (
    id TEXT PRIMARY KEY NOT NULL,
    vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    body TEXT NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 10000),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX notes_history ON notes(vehicle_id, created_at, id);
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY NOT NULL,
    vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL UNIQUE CHECK(relative_path NOT LIKE '%/%' AND relative_path NOT LIKE '%\\%'),
    mime_type TEXT NOT NULL CHECK(mime_type LIKE 'image/%'),
    caption TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX attachments_history ON attachments(vehicle_id, created_at, id);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL,
    vehicle_id TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
    due_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done')),
    repeat_mode TEXT NOT NULL DEFAULT 'none' CHECK(repeat_mode IN ('none','daily','weekly')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX tasks_schedule ON tasks(status, due_at, id);
  CREATE INDEX tasks_vehicle ON tasks(vehicle_id, due_at);
  CREATE TABLE reminders (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    scheduled_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX reminders_task ON reminders(task_id, scheduled_at);
  CREATE TABLE notification_log (
    id TEXT PRIMARY KEY NOT NULL,
    reminder_id TEXT REFERENCES reminders(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    event TEXT NOT NULL CHECK(event IN ('scheduled','received','opened','cancelled')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX notification_provider ON notification_log(provider, provider_id, created_at);`,
  // S0's CHECK constraints cannot represent unnamed cars or video. Keep every shipped
  // table as a legacy snapshot; copy identities and children into the expanded schema.
  `CREATE TABLE lots (
    id TEXT PRIMARY KEY NOT NULL,
    lot_type TEXT NOT NULL DEFAULT 'regular' CHECK(lot_type IN ('regular','corporate')),
    status TEXT NOT NULL DEFAULT 'cold' CHECK(status IN ('cold','in_progress','completed')),
    completion_reason TEXT CHECK(completion_reason IN ('bought','sold_elsewhere','declined','other')),
    make TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', title TEXT, source_url TEXT,
    seller TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', year TEXT NOT NULL DEFAULT '', mileage TEXT NOT NULL DEFAULT '',
    listing_price TEXT NOT NULL DEFAULT '', buyout_price TEXT NOT NULL DEFAULT '', market_price TEXT NOT NULL DEFAULT '',
    prep_cost TEXT NOT NULL DEFAULT '', purchase_price TEXT NOT NULL DEFAULT '', purchase_date TEXT NOT NULL DEFAULT '',
    autoteka_url TEXT NOT NULL DEFAULT '', inspection_place TEXT NOT NULL DEFAULT '', inspection_at TEXT NOT NULL DEFAULT '',
    substatus TEXT NOT NULL DEFAULT '' CHECK(substatus IN ('','bargaining','awaiting_decision','documents')),
    cover_id TEXT, search_text TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    CHECK((status='completed' AND completion_reason IS NOT NULL) OR (status!='completed' AND completion_reason IS NULL))
  );
  INSERT INTO lots(id,lot_type,status,completion_reason,make,model,title,source_url,created_at,updated_at)
    SELECT id,lot_type,status,completion_reason,make,model,title,source_url,created_at,updated_at FROM vehicles;
  CREATE INDEX lots_list ON lots(status,lot_type,updated_at DESC,id);
  CREATE TABLE lot_notes (
    id TEXT PRIMARY KEY NOT NULL, vehicle_id TEXT NOT NULL REFERENCES lots(id),
    body TEXT NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 10000), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  INSERT INTO lot_notes SELECT * FROM notes;
  CREATE INDEX lot_notes_history ON lot_notes(vehicle_id,created_at,id);
  CREATE TABLE lot_media (
    id TEXT PRIMARY KEY NOT NULL, vehicle_id TEXT NOT NULL REFERENCES lots(id),
    relative_path TEXT NOT NULL UNIQUE CHECK(relative_path NOT LIKE '%/%' AND relative_path NOT LIKE '%\\%'),
    mime_type TEXT NOT NULL CHECK(mime_type LIKE 'image/%' OR mime_type LIKE 'video/%'),
    caption TEXT NOT NULL DEFAULT '', byte_size INTEGER NOT NULL DEFAULT 0 CHECK(byte_size>=0),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  INSERT INTO lot_media(id,vehicle_id,relative_path,mime_type,caption,created_at,updated_at) SELECT * FROM attachments;
  CREATE INDEX lot_media_history ON lot_media(vehicle_id,created_at,id);
  CREATE TABLE lot_tasks (
    id TEXT PRIMARY KEY NOT NULL, vehicle_id TEXT NOT NULL REFERENCES lots(id),
    title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200), due_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done')),
    repeat_mode TEXT NOT NULL DEFAULT 'none' CHECK(repeat_mode IN ('none','daily','weekly')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
  );
  INSERT INTO lot_tasks(id,vehicle_id,title,due_at,status,repeat_mode,created_at,updated_at) SELECT * FROM tasks;
  CREATE INDEX lot_tasks_schedule ON lot_tasks(status,due_at,id);
  CREATE INDEX lot_tasks_vehicle ON lot_tasks(vehicle_id,due_at);
  CREATE TABLE lot_events(id TEXT PRIMARY KEY NOT NULL,vehicle_id TEXT NOT NULL REFERENCES lots(id),kind TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL);
  CREATE INDEX lot_events_history ON lot_events(vehicle_id,created_at,id);
  CREATE TABLE task_reminders(task_id TEXT PRIMARY KEY NOT NULL REFERENCES lot_tasks(id),provider_id TEXT UNIQUE, due_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','scheduled','error')), error TEXT);
  INSERT INTO task_reminders(task_id,provider_id,due_at,state)
    SELECT t.id,COALESCE((SELECT id FROM reminders WHERE task_id=t.id ORDER BY scheduled_at DESC LIMIT 1),t.id),t.due_at,'pending'
    FROM lot_tasks t JOIN lots v ON v.id=t.vehicle_id WHERE t.status='pending' AND v.status!='completed';
  CREATE TABLE app_settings(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
  CREATE TABLE media_cleanup(relative_path TEXT PRIMARY KEY NOT NULL);
  CREATE TABLE notification_cancellations(provider_id TEXT PRIMARY KEY NOT NULL);
  ALTER TABLE notification_log ADD COLUMN task_id TEXT;
  ALTER TABLE notification_log ADD COLUMN vehicle_id TEXT;`,
  `CREATE TABLE telegram_sent (
    device_id TEXT NOT NULL,task_id TEXT NOT NULL,remote_revision INTEGER NOT NULL,local_revision INTEGER NOT NULL,
    payload TEXT NOT NULL,uploaded INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(device_id,task_id)
  );
  CREATE TABLE telegram_receipts(device_id TEXT NOT NULL,seq INTEGER NOT NULL,task_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(device_id,seq));`,
  `ALTER TABLE lot_tasks ADD COLUMN description TEXT NOT NULL DEFAULT '';`,
  `ALTER TABLE lots ADD COLUMN archived_at INTEGER;
  UPDATE lots SET archived_at=(SELECT MAX(e.created_at) FROM lot_events e
    WHERE e.vehicle_id=lots.id AND e.kind='stage' AND e.body LIKE 'Стадия: Завершено%')
    WHERE status='completed';
  CREATE INDEX lots_active_recent ON lots(updated_at DESC,id DESC) WHERE status!='completed';
  CREATE INDEX lots_archive_recent ON lots(updated_at DESC,id DESC) WHERE status='completed';
  CREATE INDEX lot_tasks_pending_vehicle ON lot_tasks(vehicle_id,due_at,id) WHERE status='pending';
  ALTER TABLE notification_cancellations ADD COLUMN task_id TEXT;`,
  `ALTER TABLE lots ADD COLUMN last_contact_at INTEGER;
  ALTER TABLE lots ADD COLUMN review_after INTEGER;
  ALTER TABLE lot_tasks ADD COLUMN important INTEGER NOT NULL DEFAULT 0 CHECK(important IN (0,1));
  UPDATE lots SET last_contact_at=MAX(created_at,
    COALESCE((SELECT MAX(n.updated_at) FROM lot_notes n WHERE n.vehicle_id=lots.id),created_at),
    COALESCE((SELECT MAX(e.created_at) FROM lot_events e WHERE e.vehicle_id=lots.id AND e.kind IN ('stage','task','task_done')),created_at));
  UPDATE notification_cancellations SET task_id=(SELECT n.task_id FROM notification_log n
    WHERE n.provider='android' AND n.provider_id=notification_cancellations.provider_id AND n.task_id IS NOT NULL LIMIT 1)
    WHERE task_id IS NULL;
  CREATE TABLE review_reminders(kind TEXT PRIMARY KEY NOT NULL, provider_id TEXT UNIQUE NOT NULL, due_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending', error TEXT);`,
  `CREATE TABLE telegram_generation(id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL);
  INSERT INTO telegram_generation VALUES(1,1);
  CREATE TRIGGER telegram_task_insert AFTER INSERT ON lot_tasks BEGIN UPDATE telegram_generation SET generation=generation+1; END;
  CREATE TRIGGER telegram_task_update AFTER UPDATE ON lot_tasks BEGIN UPDATE telegram_generation SET generation=generation+1; END;
  CREATE TRIGGER telegram_task_delete AFTER DELETE ON lot_tasks BEGIN UPDATE telegram_generation SET generation=generation+1; END;
  CREATE TRIGGER telegram_lot_insert AFTER INSERT ON lots BEGIN UPDATE telegram_generation SET generation=generation+1; END;
  CREATE TRIGGER telegram_lot_update AFTER UPDATE OF title,make,model,phone,status,substatus,archived_at,last_contact_at,review_after,buyout_price,market_price ON lots
    BEGIN UPDATE telegram_generation SET generation=generation+1; END;
  CREATE TRIGGER telegram_lot_delete AFTER DELETE ON lots BEGIN UPDATE telegram_generation SET generation=generation+1; END;
  CREATE TRIGGER telegram_review_setting_insert AFTER INSERT ON app_settings WHEN NEW.key IN ('review_cold_days','review_archive_days')
    BEGIN UPDATE telegram_generation SET generation=generation+1; END;
  CREATE TRIGGER telegram_review_setting_update AFTER UPDATE ON app_settings WHEN NEW.key IN ('review_cold_days','review_archive_days')
    BEGIN UPDATE telegram_generation SET generation=generation+1; END;`,
];

export async function migrate(db: Connection, steps: readonly string[] = migrations): Promise<void> {
  await db.execAsync('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  await db.withTransactionAsync(async () => {
    const version = (await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0;
    if (version > steps.length) throw new Error('База создана более новой версией Auto CRM. Обновите приложение.');
    for (let i = version; i < steps.length; i++) {
      await db.execAsync(steps[i]!);
      if (i === 1) {
        const cars = await db.getAllAsync<Record<string, string | number | null>>('SELECT * FROM lots');
        for (const car of cars) {
          const notes = await db.getAllAsync<{ body: string }>('SELECT body FROM lot_notes WHERE vehicle_id=?', String(car.id));
          await db.runAsync('UPDATE lots SET search_text=? WHERE id=?',
            [...Object.values(car), ...notes.map(n => n.body)].join(' ').toLocaleLowerCase('ru-RU'), String(car.id));
        }
      }
      await db.execAsync(`PRAGMA user_version = ${i + 1}`);
    }
  });
}
