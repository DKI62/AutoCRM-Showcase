import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { Image } from 'react-native';
import type { CrmRepository, ManagedImage } from '../repositories/crm-repository';
import { settings } from '../settings';
import { assertLocalImageUri, assertManagedPath, imageExtension, resolveMediaType } from './image-rules';
import { copyMediaSafely } from './media-copy';
import { processMediaCleanup, recoverMediaCopies } from './media-recovery';

const directory = () => new Directory(Paths.document, settings.mediaDirectory);
const pending = () => new Directory(Paths.document, `${settings.mediaDirectory}-pending`);
const active = new Set<string>();
const marker = (path: string) => new File(pending(), path);
const part = (path: string) => new File(directory(), `${path}.part`);
function remove(file: File) { if (file.exists) file.delete(); }

export function beginMediaCopy(path: string): File {
  const target = imageFile(path);
  if (target.exists || part(path).exists || marker(path).exists || active.has(path)) throw new Error('Не удалось выделить уникальный путь для файла.');
  directory().create({ idempotent: true, intermediates: true });
  pending().create({ idempotent: true, intermediates: true });
  marker(path).create();
  active.add(path);
  return target;
}

export function acceptMediaCopies(items: readonly Pick<ManagedImage, 'relative_path'>[]) {
  for (const { relative_path: path } of items) {
    active.delete(path);
    try { assertManagedPath(path); remove(marker(path)); } catch { /* The next recovery checks SQLite first. */ }
  }
}

export async function recoverInterruptedMedia(repository: CrmRepository) {
  if (!pending().exists) return;
  const paths = pending().list().filter(file => file instanceof File && !active.has(file.name)).map(file => file.name);
  await recoverMediaCopies(paths, path => repository.hasMediaPath(path), (path, committed) => {
    if (active.has(path)) return;
    remove(part(path));
    if (!committed) remove(imageFile(path));
    remove(marker(path));
  });
}

export async function compensateMediaCopies(repository: CrmRepository, items: readonly Pick<ManagedImage, 'relative_path'>[]) {
  for (const item of items) {
    const path = item.relative_path;
    try {
      if (await repository.hasMediaPath(path)) acceptMediaCopies([item]);
      else discardImage(item);
    } catch { active.delete(path); /* Keep the marker if SQLite or storage cannot establish ownership. */ }
  }
}

let cleanupRunning: Promise<number> | undefined;
export function finishMediaCleanup(repository: CrmRepository) {
  if (!cleanupRunning) cleanupRunning = processMediaCleanup(repository, discardImage).finally(() => { cleanupRunning = undefined; });
  return cleanupRunning;
}

export function imageFile(path: string): File {
  assertManagedPath(path);
  return new File(directory(), path);
}

export async function importImage(uri: string, mime?: string | null, name = uri): Promise<ManagedImage> {
  try { return await copyLocalMedia(uri, mime, name); }
  catch (error) {
    if (error instanceof Error && /[а-яё]/i.test(error.message)) throw error;
    const message = error instanceof Error ? error.message : '';
    if (Paths.availableDiskSpace < 8 * 1024 * 1024 || /ENOSPC|no space/i.test(message)) throw new Error('Память устройства заполнена. Освободите место и выберите файл заново.', { cause: error });
    if (/permission|denied|EACCES|security/i.test(message)) throw new Error('Android закрыл доступ к файлу. Выберите его заново через галерею или «Файлы».', { cause: error });
    throw new Error('Не удалось прочитать и сохранить медиа. Выберите исходный файл заново; для фото попробуйте PNG или JPEG.', { cause: error });
  }
}

async function copyLocalMedia(uri: string, mime?: string | null, name = uri): Promise<ManagedImage> {
  assertLocalImageUri(uri);
  const source = new File(uri);
  const type = resolveMediaType(mime, name, source.type);
  const extension = imageExtension(type);
  const relative_path = `${randomUUID()}.${extension}`;
  const target = beginMediaCopy(relative_path);
  const staging = part(relative_path);
  try {
    const byte_size = await copyMediaSafely({
      sourceSize: source.size, freeBytes: Paths.availableDiskSpace,
      copy: () => source.copy(staging), copiedSize: () => staging.exists ? staging.size : 0,
      validate: async () => { if (type.startsWith('image/')) await Image.getSize(staging.uri); },
      commit: () => staging.move(target),
      cleanup: () => discardImage({ relative_path }),
    });
    return { relative_path, mime_type: type, byte_size };
  } catch (error) { active.delete(relative_path); throw error; }
}

export function discardImage({ relative_path: path }: Pick<ManagedImage, 'relative_path'>): void {
  const file = imageFile(path);
  try { remove(part(path)); remove(file); remove(marker(path)); }
  finally { active.delete(path); }
}
export function assertReadyMedia(items: readonly ManagedImage[]): void {
  for (const item of items) {
    const file = imageFile(item.relative_path);
    if (!file.exists || !file.size || (item.byte_size != null && file.size !== item.byte_size))
      throw new Error('Один из файлов недоступен или скопирован не полностью. Выберите его заново.');
  }
}
