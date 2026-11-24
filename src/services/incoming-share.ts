import { randomUUID } from 'expo-crypto';
import { clearSharedPayloads, getSharedPayloads, type SharePayload } from 'expo-sharing';
import type { ManagedImage } from '../repositories/crm-repository';
import { discardImage, importImage } from './image-files';
import { importBatch } from './media-copy';
import { drainShareInbox, parseShare } from './share-input';

export interface IncomingDraft { images: ManagedImage[]; note: string; sourceUrl: string; error: string | null }
const drafts = new Map<string, Promise<IncomingDraft>>();
export function takeIncomingDrafts() { return drainShareInbox(drafts); }
export function receiveShare(): string {
  const payloads = getSharedPayloads(); if (!payloads.length) return '/add';
  const id = randomUUID(); drafts.set(id, loadPayloads(payloads)); clearSharedPayloads();
  return `/add?incoming=${id}`;
}
async function loadPayloads(payloads: SharePayload[]): Promise<IncomingDraft> {
  const draft: IncomingDraft = { images: [], note: '', sourceUrl: '', error: null };
  try {
    const input = parseShare(payloads); draft.note = input.note; draft.sourceUrl = input.sourceUrl;
    draft.images = await importBatch(input.images, item => importImage(item.uri, item.mime), discardImage);
  } catch (error) { draft.error = error instanceof Error ? error.message : 'Не удалось прочитать переданные данные.'; }
  return draft;
}
