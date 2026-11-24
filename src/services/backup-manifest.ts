import { detailFields, reasonLabels, substatusLabels, validateVehicle } from '../domain/models';
import { assertManagedPath, imageExtension } from './image-rules';

export const backupColumns: Record<string, readonly string[]> = {
  lots: ['id', 'lot_type', 'status', 'completion_reason', 'make', 'model', 'title', 'source_url', ...detailFields, 'substatus', 'cover_id', 'search_text', 'created_at', 'updated_at', 'archived_at', 'last_contact_at', 'review_after'],
  lot_notes: ['id', 'vehicle_id', 'body', 'created_at', 'updated_at'],
  lot_media: ['id', 'vehicle_id', 'relative_path', 'mime_type', 'caption', 'byte_size', 'created_at', 'updated_at'],
  lot_tasks: ['id', 'vehicle_id', 'title', 'due_at', 'status', 'repeat_mode', 'created_at', 'updated_at', 'completed_at', 'description', 'important'],
  lot_events: ['id', 'vehicle_id', 'kind', 'body', 'created_at'],
};
export const backupPreferenceKeys = ['notification_sound', 'notification_vibration', 'review_cold_days', 'review_archive_days'] as const;
export type BackupPreferences = Partial<Record<typeof backupPreferenceKeys[number], string>>;
export function isBackupPreference(key: string, value: unknown): value is string {
  if (key === 'notification_sound' || key === 'notification_vibration') return value === 'on' || value === 'off';
  if (key === 'review_cold_days') return ['0', '7', '14', '30'].some(item => item === value);
  if (key === 'review_archive_days') return ['0', '7', '14', '30', '60'].some(item => item === value);
  return false;
}
export interface BackupManifest {
  format: 'auto-crm-folder'; version: 1 | 2; createdAt: number;
  tables: Record<string, Record<string, unknown>[]>;
  files: { path: string; size: number; md5: string }[];
  preferences?: BackupPreferences;
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new Error('Резервная копия повреждена или имеет неподдерживаемую структуру. Данные не изменены.');
export function validateManifest(value: unknown): BackupManifest {
  if (!record(value) || value.format !== 'auto-crm-folder' || (value.version !== 1 && value.version !== 2) || !Number.isSafeInteger(value.createdAt) || !record(value.tables) || !Array.isArray(value.files)) throw invalid();
  const tables = value.tables as BackupManifest['tables'];
  if (value.preferences !== undefined && (!record(value.preferences) || Object.entries(value.preferences).some(([key, setting]) =>
    !isBackupPreference(key, setting)))) throw invalid();
  if (Object.keys(tables).some(key => !Object.hasOwn(backupColumns, key))) throw invalid();
  const ids: Record<string, Set<string>> = {};
  for (const [table, columns] of Object.entries(backupColumns)) {
    const rows: unknown = tables[table]; if (!Array.isArray(rows)) throw invalid();
    const seen = new Set<string>(); ids[table] = seen;
    for (const row of rows) {
      const optional = table === 'lots' ? ['last_contact_at', 'review_after'] : table === 'lot_tasks' ? ['important'] : [];
      if (value.version === 1 && table === 'lots') optional.push('archived_at');
      if (value.version === 1 && table === 'lot_tasks') optional.push('description');
      if (!record(row) || columns.some(key => !Object.hasOwn(row, key) && !optional.includes(key)) || Object.keys(row).some(key => !columns.includes(key)) || !uuid(row.id) || seen.has(row.id)) throw invalid();
      seen.add(row.id);
      for (const [key, item] of Object.entries(row)) {
        const numeric = ['created_at', 'updated_at', 'due_at', 'completed_at', 'archived_at', 'byte_size', 'important', 'last_contact_at', 'review_after'].includes(key);
        const nullable = (table === 'lots' && ['title', 'source_url', 'cover_id', 'completion_reason', 'archived_at', 'last_contact_at', 'review_after'].includes(key)) || key === 'completed_at';
        if (item === null) { if (!nullable) throw invalid(); continue; }
        if (typeof item !== (numeric ? 'number' : 'string')) throw invalid();
        if (typeof item === 'string' && item.length > (key === 'search_text' ? 10_000_000 : key === 'description' ? 2000 : 10000)) throw invalid();
        if (typeof item === 'number' && (!Number.isSafeInteger(item) || item < 0)) throw invalid();
        if (numeric && key !== 'byte_size' && !Number.isFinite(new Date(Number(item)).getTime())) throw invalid();
      }
      if (table === 'lots') {
        validateVehicle({ make: String(row.make), model: String(row.model), title: String(row.title ?? ''), note: '', phone: String(row.phone), sourceUrl: String(row.source_url ?? ''), autoteka_url: String(row.autoteka_url) });
        if (!['regular', 'corporate'].includes(String(row.lot_type)) || !['cold', 'in_progress', 'completed'].includes(String(row.status))) throw invalid();
        if (row.completion_reason !== null && (!Object.hasOwn(reasonLabels, String(row.completion_reason)) || row.status !== 'completed')) throw invalid();
        if (row.archived_at != null && row.status !== 'completed') throw invalid();
        if (row.substatus !== '' && !Object.hasOwn(substatusLabels, String(row.substatus))) throw invalid();
      } else if (!uuid(row.vehicle_id)) throw invalid();
      if (table === 'lot_tasks' && (!['pending', 'done'].includes(String(row.status)) || !['none', 'daily', 'weekly'].includes(String(row.repeat_mode)) || (row.important !== undefined && row.important !== 0 && row.important !== 1))) throw invalid();
    }
  }
  for (const table of ['lot_notes', 'lot_media', 'lot_tasks', 'lot_events']) for (const row of tables[table]!) if (!ids.lots!.has(String(row.vehicle_id))) throw invalid();
  const files = value.files as BackupManifest['files']; const paths = new Map<string, number>();
  for (const file of files) {
    if (!record(file) || typeof file.path !== 'string' || typeof file.md5 !== 'string' || !/^[a-f0-9]{32}$/i.test(file.md5) || !Number.isSafeInteger(file.size) || file.size < 1 || paths.has(file.path)) throw invalid();
    assertManagedPath(file.path); paths.set(file.path, file.size);
  }
  const media = tables.lot_media!;
  if (media.length !== paths.size || new Set(media.map(row => row.relative_path)).size !== media.length) throw invalid();
  for (const row of media) {
    assertManagedPath(String(row.relative_path)); imageExtension(String(row.mime_type));
    if (!paths.has(String(row.relative_path))) throw invalid();
    if (Number(row.byte_size) > 0 && paths.get(String(row.relative_path)) !== row.byte_size) throw invalid();
  }
  const covers = new Map(media.filter(row => String(row.mime_type).startsWith('image/')).map(row => [row.id, row.vehicle_id]));
  for (const car of tables.lots!) if (car.cover_id !== null && covers.get(car.cover_id) !== car.id) throw invalid();
  return value as unknown as BackupManifest;
}

export function assertCompleteBackup(names: readonly string[]) {
  if (names.includes('INCOMPLETE.txt')) throw new Error('Эта резервная копия не завершена. Выберите другую папку.');
  if (!names.includes('manifest.json')) throw new Error('Выберите папку AutoCRM с manifest.json и папкой media.');
}

export function assertBackupMetadataSize(size: number) {
  if (size > 64 * 1024 * 1024) throw new Error('Метаданные копии превышают 64 МБ. Эта версия не сможет восстановить их. Размер файлов фото и видео не ограничен.');
}
