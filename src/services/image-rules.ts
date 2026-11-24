const imageTypes: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'video/x-matroska': 'mkv', 'video/3gpp': '3gp',
};

export function imageExtension(mimeType: string): string {
  const extension = imageTypes[mimeType.toLowerCase()];
  if (!extension) throw new Error('Неизвестный формат. Выберите JPEG, PNG, WebP, HEIC, MP4, MOV или WebM.');
  return extension;
}

export function assertLocalImageUri(uri: string): void {
  if (!/^(file|content):\/\//i.test(uri)) throw new Error('Изображение должно быть локальным файлом.');
}

export function assertManagedPath(path: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif|heic|heif|mp4|mov|webm|mkv|3gp)$/i.test(path))
    throw new Error('Некорректный путь изображения.');
}

export function resolveMediaType(mime: string | null | undefined, name: string, nativeType = ''): string {
  for (const candidate of [mime, nativeType]) {
    const normalized = (candidate || '').toLowerCase().split(';')[0]!.trim();
    if (imageTypes[normalized]) return normalized;
  }
  const extension = name.split(/[?#]/)[0]!.split('.').pop()?.toLowerCase();
  const inferred = Object.entries(imageTypes).find(([, value]) => value === extension)?.[0];
  if (inferred) return inferred;
  if (extension === 'jpeg') return 'image/jpeg';
  throw new Error('Не удалось определить формат файла. Попробуйте выбрать его через «Файлы».');
}
