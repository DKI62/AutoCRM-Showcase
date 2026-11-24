import type * as Notifications from 'expo-notifications';
import { settings } from '../settings';
import type { DiagnosticEvent, DiagnosticValues } from './diagnostic-format';

export interface NotificationService {
  readonly provider: string;
  permission(): Promise<boolean>;
  requestPermission(): Promise<boolean>;
  schedule(input: { id: string; title: string; body: string; at: Date; vehicleId?: string; taskId?: string; sound?: boolean; vibration?: boolean }): Promise<string>;
  cancel(id: string): Promise<void>;
}
export type NotificationApi = Pick<typeof Notifications,
  'getNotificationChannelAsync' | 'setNotificationChannelAsync' | 'getPermissionsAsync' | 'requestPermissionsAsync' |
  'getNextTriggerDateAsync' | 'getAllScheduledNotificationsAsync' |
  'scheduleNotificationAsync' | 'cancelScheduledNotificationAsync' | 'dismissNotificationAsync' | 'AndroidImportance' | 'SchedulableTriggerInputTypes'>;

export function nativeTriggerTime(trigger: unknown): number | null {
  if (!trigger || typeof trigger !== 'object' || !('type' in trigger) || trigger.type !== 'date') return null;
  if ('value' in trigger && typeof trigger.value === 'number') return trigger.value;
  if ('date' in trigger && typeof trigger.date === 'number') return trigger.date;
  if ('date' in trigger && trigger.date instanceof Date) return trigger.date.getTime();
  return null;
}

export function createAndroidNotifications(api: NotificationApi, report?: (event: DiagnosticEvent, values: DiagnosticValues) => void) {
  const channels = new Map<string, Promise<string>>();
  function ensureChannel(sound = true, vibration = true): Promise<string> {
    const id = `reminders-v2-s${Number(sound)}-v${Number(vibration)}`;
    const existing = channels.get(id); if (existing) return existing;
    const setup = (async () => {
      // Existing Android channels retain the user's system settings. SDK 57 resolves
      // the old unrecognised "default" filename to the system URI, so no new ID is needed.
      if (!(await api.getNotificationChannelAsync(id))) await api.setNotificationChannelAsync(id, {
        name: settings.notificationChannel.name, importance: api.AndroidImportance.HIGH,
        vibrationPattern: vibration ? [...settings.notificationChannel.vibrationPattern] : [0], enableVibrate: vibration,
        // Omission selects DEFAULT_NOTIFICATION_URI. A string here means a bundled custom file.
        ...(sound ? {} : { sound: null }),
      });
      return id;
    })().catch(error => { channels.delete(id); throw error; });
    channels.set(id, setup); return setup;
  }
  const service: NotificationService = {
    provider: 'android',
    async permission() { return (await api.getPermissionsAsync()).granted; },
    async requestPermission() {
      await ensureChannel(); const current = await api.getPermissionsAsync();
      if (current.granted) return true; if (!current.canAskAgain) return false;
      return (await api.requestPermissionsAsync()).granted;
    },
    async schedule({ id, title, body, at, vehicleId, taskId, sound = true, vibration = true }) {
      if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) throw new Error('Укажите будущее время уведомления.');
      const channelId = await ensureChannel(sound, vibration);
      const allowed = await this.permission();
      if (!allowed) {
        report?.('alarm.permission', { due: at.getTime(), allowed: 0 });
        throw new Error('Нет разрешения на уведомления.');
      }
      const channel = await api.getNotificationChannelAsync(channelId);
      report?.('alarm.permission', { due: at.getTime(), allowed: 1, importance: channel?.importance ?? -1 });
      if (!channel) { channels.delete(channelId); throw new Error('Канал уведомлений отсутствует. Повторите попытку.'); }
      if (channel.importance === 0) throw new Error('Канал напоминаний отключён в настройках Android.');
      const trigger = { type: api.SchedulableTriggerInputTypes.DATE, date: at, channelId } as const;
      if (await api.getNextTriggerDateAsync(trigger) !== at.getTime()) throw new Error('Android не подтвердил выбранное время напоминания.');
      const nativeId = await api.scheduleNotificationAsync({ identifier: id,
        content: { title, body, sound: sound ? 'default' : false, data: vehicleId ? { vehicleId, taskId: taskId ?? null } : { diagnostic: true } },
        trigger,
      });
      if (nativeId !== id) {
        await api.cancelScheduledNotificationAsync(nativeId);
        throw new Error('Android вернул другой идентификатор напоминания.');
      }
      const request = (await api.getAllScheduledNotificationsAsync()).find(item => item.identifier === id);
      if (!request)
        throw new Error('Android не показал напоминание в списке запланированных.');
      if (nativeTriggerTime(request.trigger) !== at.getTime()) {
        await api.cancelScheduledNotificationAsync(id);
        throw new Error('В системном списке Android указан другой срок напоминания.');
      }
      return nativeId;
    },
    async cancel(id) {
      await api.cancelScheduledNotificationAsync(id);
      // A tray dismissal failure does not mean the scheduled alarm still exists.
      await api.dismissNotificationAsync(id).catch(() => undefined);
    },
  };
  return { service, ensureChannel };
}
