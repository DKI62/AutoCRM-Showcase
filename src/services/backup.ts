import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import type { CrmRepository } from '../repositories/crm-repository';
import { assertBackupMetadataSize, assertCompleteBackup, backupPreferenceKeys, isBackupPreference, validateManifest, type BackupManifest, type BackupPreferences } from './backup-manifest';
import { acceptMediaCopies, beginMediaCopy, compensateMediaCopies, imageFile } from './image-files';

function checksum(file: File) {
  const hash = file.info({ md5: true }).md5;
  if (!hash) throw new Error('Не удалось проверить целостность файла. Копия не принята.');
  return hash;
}
export async function exportBackup(repository: CrmRepository, progress: (message: string) => void): Promise<string> {
  const destination = await Directory.pickDirectoryAsync();
  const folder = destination.createDirectory(`AutoCRM-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  const marker = folder.createFile('INCOMPLETE.txt', 'text/plain'); marker.write('Backup not complete. Do not restore until manifest.json exists.');
  const tables = await repository.snapshot(); const media = folder.createDirectory('media');
  const preferences: BackupPreferences = {};
  for (const key of backupPreferenceKeys) { const value = await repository.getSetting(key); if (isBackupPreference(key, value)) preferences[key] = value; }
  const manifest: BackupManifest = { format: 'auto-crm-folder', version: 2, createdAt: Date.now(), tables, files: [], preferences };
  const rows = tables.lot_media ?? [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!; progress(`Копируем файл ${index + 1} из ${rows.length}`);
    const source = imageFile(String(row.relative_path)); if (!source.exists || source.size < 1) throw new Error('Один из сохранённых файлов недоступен. Резервная копия не завершена.');
    // Copy into the SAF directory: SDK 57 creates the child document itself.
    // Precreating and overwriting a SAF File deletes that document's URI first.
    await source.copy(media);
    const md5 = checksum(source);
    manifest.files.push({ path: String(row.relative_path), size: source.size, md5 });
  }
  const copiedFiles = new Map(media.list().filter((file): file is File => file instanceof File).map(file => [file.name, file]));
  for (const expected of manifest.files) {
    progress('Проверяем целостность скопированных файлов…');
    const target = copiedFiles.get(expected.path);
    if (!target || target.size !== expected.size || checksum(target) !== expected.md5) throw new Error('Файл в копии не прошёл проверку. Резервная копия не завершена.');
  }
  validateManifest(manifest);
  const text = JSON.stringify(manifest); assertBackupMetadataSize(text.length);
  const file = folder.createFile('manifest.json', 'application/json'); file.write(text);
  assertBackupMetadataSize(file.size);
  validateManifest(JSON.parse(await file.text())); marker.delete(); progress('Копия проверена'); return folder.uri;
}
export async function readBackup(): Promise<{ folder: Directory; manifest: BackupManifest }> {
  const folder = await Directory.pickDirectoryAsync();
  const entries = folder.list();
  assertCompleteBackup(entries.map(file => file.name));
  const manifestFile = entries.find(file => file.name === 'manifest.json');
  if (!(manifestFile instanceof File)) throw new Error('Выберите папку AutoCRM с manifest.json и папкой media.');
  assertBackupMetadataSize(manifestFile.size);
  const text = await manifestFile.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('Файл метаданных повреждён. Данные не изменены.'); }
  return { folder, manifest: validateManifest(parsed) };
}
let restoring = false;
export async function restoreBackup(repository: CrmRepository, backup: Awaited<ReturnType<typeof readBackup>>, progress: (message: string) => void): Promise<number> {
  if (restoring) throw new Error('Дождитесь завершения текущего восстановления.');
  restoring = true;
  try { return await restore(repository, backup, progress); } finally { restoring = false; }
}

async function restore(repository: CrmRepository, backup: Awaited<ReturnType<typeof readBackup>>, progress: (message: string) => void): Promise<number> {
  const { folder, manifest } = backup;
  // Validate again at the write boundary; SQL column names come only from the fixed schema.
  validateManifest(manifest);
  const existing = new Set(await repository.existingVehicleIds());
  const fresh = new Set(manifest.tables.lots!.filter(row => !existing.has(String(row.id))).map(row => String(row.id)));
  const needed = manifest.tables.lot_media!.filter(row => fresh.has(String(row.vehicle_id)));
  const mediaFolder = folder.list().find(file => file.name === 'media');
  if (manifest.files.length && !(mediaFolder instanceof Directory)) throw new Error('В копии нет папки media. Данные не изменены.');
  const sourceFiles = mediaFolder instanceof Directory ? new Map(mediaFolder.list().filter((file): file is File => file instanceof File).map(file => [file.name, file])) : new Map<string, File>();
  const sizes = new Map(manifest.files.map(file => [file.path, file]));
  const requiredBytes = needed.reduce((total, row) => total + sizes.get(String(row.relative_path))!.size, 0);
  if (Paths.availableDiskSpace < requiredBytes + 8 * 1024 * 1024) throw new Error('Не хватает места для восстановления всех файлов. Данные не изменены.');
  const copied: { relative_path: string }[] = [], paths = new Map<string, string>(); let committed = false;
  try {
    for (let index = 0; index < needed.length; index++) {
      progress(`Проверяем и восстанавливаем файл ${index + 1} из ${needed.length}`);
      const row = needed[index]!, old = String(row.relative_path), expected = sizes.get(old)!, source = sourceFiles.get(old);
      if (!source || source.size !== expected.size || checksum(source) !== expected.md5) throw new Error('Файл отсутствует или повреждён в резервной копии. Данные не изменены.');
      const path = `${randomUUID()}.${old.split('.').pop()}`; const target = beginMediaCopy(path);
      copied.push({ relative_path: path });
      await source.copy(target);
      if (target.size !== expected.size || checksum(target) !== expected.md5) throw new Error('Не удалось проверить восстановленный файл. Данные не изменены.');
      paths.set(old, path);
    }
    const count = await repository.restoreRows(manifest.tables, paths, manifest.preferences);
    committed = true;
    acceptMediaCopies(copied);
    return count;
  } finally {
    if (!committed) await compensateMediaCopies(repository, copied);
  }
}
