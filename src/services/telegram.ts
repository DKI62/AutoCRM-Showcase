import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import type { CrmRepository } from '../repositories/crm-repository';
import { isUuid, validAction, type RemoteAction } from './telegram-protocol';
import { pairingCodePattern, pairingOffer, pairingVersion, type PairingCandidate } from './telegram-pairing';
import { reviewDays, reviewSetting } from '../domain/vehicle-review';
import { reconcileReminders } from './task-reminders';
import { observeTelegramTaskChanges } from './telegram-task-sync';
import { diagnostic } from './diagnostics';
import type { telegramHttp } from './telegram-http';

const storageKey = 'autocrm.showcase.telegram.device';
interface Connection { origin: string; deviceId: string; token: string; pairingVersion?: number }
const appScheme = () => Constants.expoConfig?.scheme === 'autocrm-showcase-dev' ? 'autocrm-showcase-dev' : 'autocrm-showcase';
export function serverOrigin(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Укажите HTTPS-адрес своего сервера без пути, параметров и пароля.');
  return url.origin;
}
async function connection(): Promise<Connection | null> {
  const value = await SecureStore.getItemAsync(storageKey); return value ? JSON.parse(value) as Connection : null;
}
const request: ReturnType<typeof telegramHttp> = async () => {
  throw new Error('В Showcase обмен с Telegram отключён. Серверный протокол можно проверить локальными тестами.');
};
export async function telegramStatus(repository: CrmRepository) {
  const current = await connection();
  const linked = !!current && (await repository.getSetting('telegram_linked')) === 'on';
  const pendingRevocation = !!current && (await repository.getSetting('telegram_revoke')) === 'on';
  const remote = current?.pairingVersion === pairingVersion && !linked && !pendingRevocation
    ? await readDeviceState(current).catch(() => null) : null;
  return { configured: !!current, origin: current?.origin ?? '', enabled: (await repository.getSetting('telegram_enabled')) === 'on',
    pendingRevocation, error: await repository.getSetting('telegram_error'),
    lastSync: Number(await repository.getSetting('telegram_last_sync')) || null,
    linked, pairingCandidate: remote?.candidate ?? null, pairingState: remote?.pairingState ?? null,
    conflict: await repository.getSetting('telegram_conflict'),
    pending: current && linked ? await repository.telegramPending(current.deviceId) > 0 : false };
}
async function readDeviceState(current: Connection) {
  const state = await request(current.origin, '/v1/device', current.token) as {
    linked?: boolean; pairingState?: 'waiting' | 'pending' | 'expired' | 'rejected'; candidate?: PairingCandidate;
  } | null;
  if (typeof state?.linked !== 'boolean') throw new Error('Сервер вернул некорректный статус привязки.');
  if (state.candidate && (!isUuid(state.candidate.requestId) ||
    (state.candidate.displayName !== null && typeof state.candidate.displayName !== 'string') ||
    (state.candidate.username !== null && typeof state.candidate.username !== 'string')))
    throw new Error('Сервер вернул некорректный запрос привязки.');
  return state;
}
export async function pairTelegram(repository: CrmRepository, endpoint: string): Promise<string> {
  if (await connection()) throw new Error('Сначала отключите прежнее подключение.');
  const origin = serverOrigin(endpoint);
  const result = pairingOffer(await request(origin, '/v1/pair', undefined, { app: appScheme(), pairingVersion }));
  if (!result) throw new Error('Сервер не подтвердил безопасную привязку. Обновите Worker перед подключением.');
  await repository.setSettings({ telegram_enabled: 'on', telegram_error: '', telegram_revoke: 'off', telegram_last_sync: '', telegram_linked: 'off', telegram_retry_at: '', telegram_failures: '', telegram_conflict: '' });
  await SecureStore.setItemAsync(storageKey, JSON.stringify({ origin, deviceId: result.deviceId, token: result.token, pairingVersion }));
  return result.bindUrl;
}
export async function decideTelegramPairing(requestId: string, code: string | null) {
  const current = await connection();
  if (current?.pairingVersion !== pairingVersion || !isUuid(requestId)) throw new Error('Запрос привязки устарел.');
  if (code !== null && !pairingCodePattern.test(code)) throw new Error('Введите 12 символов кода из чата с ботом.');
  const result = await request(current.origin, '/v1/device/pairing', current.token,
    code === null ? { requestId, approve: false } : { requestId, approve: true, code }) as { linked?: boolean; rejected?: boolean };
  if (code === null ? result?.rejected !== true : result?.linked !== true) throw new Error('Сервер не подтвердил решение.');
}
type SyncResult = { linked: boolean; uploaded: number; conflicts: number };
const runtime = globalThis as typeof globalThis & { autoCrmTelegramSync?: { running: Promise<SyncResult> | null } };
const syncState = runtime.autoCrmTelegramSync ??= { running: null };
export function observeTelegramTaskSync(repository: CrmRepository, isActive: () => boolean) {
  return observeTelegramTaskChanges(repository, isActive, () => syncState.running, () => syncTelegram(repository));
}

export function syncTelegram(repository: CrmRepository, force = false): Promise<SyncResult> {
  if (syncState.running) return syncState.running;
  const started = Date.now();
  syncState.running = (async () => {
    const current = await connection(); const empty = { linked: false, uploaded: 0, conflicts: 0 };
    if (!current) return empty;
    if (!force && Number(await repository.getSetting('telegram_retry_at')) > Date.now()) return { ...empty, linked: (await repository.getSetting('telegram_linked')) === 'on' };
    if ((await repository.getSetting('telegram_revoke')) === 'on') {
      await request(current.origin, '/v1/device', current.token, undefined, 'DELETE');
      await SecureStore.deleteItemAsync(storageKey);
      await repository.setSettings({ telegram_revoke: 'off', telegram_last_sync: '', telegram_error: '', telegram_linked: 'off', telegram_retry_at: '', telegram_failures: '', telegram_conflict: '' }); return empty;
    }
    if ((await repository.getSetting('telegram_enabled')) !== 'on') return empty;
    const status = await readDeviceState(current);
    if (!status.linked) { await repository.setSettings({ telegram_last_sync: '', telegram_error: '', telegram_linked: 'off', telegram_retry_at: '', telegram_failures: '' }); return empty; }
    await repository.telegramOutbox(current.deviceId, true);
    const quiet = { timezone: (await repository.getSetting('telegram_timezone')) || 'Europe/Moscow',
      start: Number((await repository.getSetting('telegram_quiet_start')) ?? 22), end: Number((await repository.getSetting('telegram_quiet_end')) ?? 8),
      morning: Number((await repository.getSetting('telegram_morning')) ?? 9), evening: Number((await repository.getSetting('telegram_evening')) ?? 19),
      overdue: (await repository.getSetting('telegram_overdue')) !== 'off', app: appScheme(),
      coldDays: reviewDays('cold', await repository.getSetting(reviewSetting.cold)), archiveDays: reviewDays('archive', await repository.getSetting(reviewSetting.archive)) };
    await request(current.origin, '/v1/quiet-hours', current.token, quiet);
    const ackKey = `telegram_ack:${current.deviceId}`;
    async function acknowledge() {
      const seq = Number(await repository.getSetting(ackKey));
      if (!seq || !current) return;
      await request(current.origin, '/v1/actions/ack', current.token, { seq, outcomes: await repository.telegramReceipts(current.deviceId, seq) });
      await repository.setSetting(ackKey, '');
    }
    await acknowledge();
    let conflicts = 0;
    // A bounded batch keeps foreground sync responsive. The next minute resumes the cursor.
    const cursor = Number((await repository.getSetting(`telegram_cursor:${current.deviceId}`)) ?? 0);
    const value = await request(current.origin, `/v1/actions?after=${cursor}`, current.token);
    if (!Array.isArray(value) || value.length > 100 || !value.every((a: unknown) => validAction(a))) throw new Error('Некорректный ответ журнала Telegram. Локальные задачи не изменены.');
    const actions = value as RemoteAction[];
    if (actions.some((action, index) => action.seq <= cursor || (index > 0 && action.seq <= actions[index - 1]!.seq))) throw new Error('Некорректный порядок событий Telegram.');
    if (actions.length) {
      conflicts = await repository.applyTelegramActions(current.deviceId, actions);
      repository.notifyChanges();
      void reconcileReminders(repository).catch(() => undefined);
      await acknowledge();
    }
    const tasks = await repository.telegramOutbox(current.deviceId, true);
    if ((await repository.getSetting('telegram_enabled')) !== 'on') return { linked: true, uploaded: 0, conflicts };
    const response = await request(current.origin, '/v1/tasks', current.token, tasks) as { accepted?: boolean };
    if (response?.accepted !== true) throw new Error('Сервер не подтвердил задачи. Они остаются в очереди.');
    await repository.confirmTelegramUpload(current.deviceId, tasks);
    if (conflicts) await repository.setSetting('telegram_conflict', `Конфликтов: ${conflicts}. Локальные изменения сохранены.`);
    await repository.setSettings({ telegram_last_sync: String(Date.now()), telegram_linked: 'on', telegram_retry_at: '', telegram_failures: '', telegram_error: '' });
    diagnostic('sync.done', { count: tasks.length, uploaded: tasks.length, conflicts, duration: Date.now() - started });
    return { linked: true, uploaded: tasks.length, conflicts };
  })().catch(async error => {
    const failures = Math.min(5, (Number(await repository.getSetting('telegram_failures')) || 0) + 1);
    const retry = Date.now() + Math.min(900000, 30000 * 2 ** failures);
    diagnostic('sync.error', { duration: Date.now() - started });
    diagnostic('sync.backoff', { retry, count: failures });
    await repository.setSettings({ telegram_error: error instanceof Error ? error.message : 'Ошибка синхронизации Telegram.',
      telegram_failures: String(failures), telegram_retry_at: String(retry) });
    throw error;
  }).finally(() => { syncState.running = null; });
  return syncState.running;
}
export async function testTelegram(repository: CrmRepository) {
  const current = await connection();
  if (!current || (await repository.getSetting('telegram_enabled')) !== 'on') throw new Error('Подключите Telegram.');
  const result = await request(current.origin, '/v1/test', current.token, {}) as { sent?: boolean };
  if (result?.sent !== true) throw new Error('Telegram не подтвердил отправку.');
}
export async function disconnectTelegram(repository: CrmRepository): Promise<void> {
  await repository.setSettings({ telegram_enabled: 'off', telegram_revoke: 'on' });
  // Revoke retries in foreground when offline; no new task payload is sent after local disable.
  if (syncState.running) await syncState.running.catch(() => undefined);
  await syncTelegram(repository, true);
}
