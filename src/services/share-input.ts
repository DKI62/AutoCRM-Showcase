import type { SharePayload } from 'expo-sharing';
import { isWebUrl } from '../domain/models';
import { assertLocalImageUri, resolveMediaType } from './image-rules';

/** The router can coalesce redirects. Taking the inbox must consume every captured payload once. */
export function drainShareInbox<T>(inbox: Map<string, T>): T[] {
  const values = [...inbox.values()];
  inbox.clear();
  return values;
}

export function parseShare(payloads: SharePayload[]) {
  if (!payloads.length) throw new Error('В «Поделиться» нет файлов или текста.');
  const images: { uri: string; mime: string }[] = [];
  let note = '', sourceUrl = '';
  for (const payload of payloads) {
    if (payload.shareType === 'text' || payload.shareType === 'url') {
      if ((payload.mimeType ?? 'text/plain') !== 'text/plain') throw new Error('Неподдерживаемый тип текста.');
      const text = payload.value.trim(); note = [note, text].filter(Boolean).join('\n');
      if (note.length > 10000) throw new Error('Переданный текст длиннее 10 000 символов.');
      if (isWebUrl(text)) sourceUrl = text;
    } else if (['image', 'video', 'file'].includes(payload.shareType)) {
      assertLocalImageUri(payload.value);
      let mime = payload.mimeType ?? '';
      try { mime = resolveMediaType(mime, payload.value); }
      catch (error) {
        // SEND_MULTIPLE commonly has image/* and opaque content:// IDs. Resolve the
        // actual MIME with File.type while the provider's read grant is active.
        if (mime && !['image/*', 'video/*', '*/*', 'application/octet-stream'].includes(mime.toLowerCase())) throw error;
      }
      images.push({ uri: payload.value, mime });
    } else throw new Error('Auto CRM принимает фото, видео и текстовые ссылки.');
  }
  return { images, image: images[0] ?? null, note, sourceUrl };
}
