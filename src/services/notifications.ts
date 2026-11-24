import * as Notifications from 'expo-notifications';
import { createAndroidNotifications, nativeTriggerTime } from './notification-service';
import { diagnostic } from './diagnostics';
import { exactAlarmStatus } from './alarm-access';
export type { NotificationService } from './notification-service';

const android = createAndroidNotifications(Notifications, diagnostic);
export const ensureNotificationChannel = android.ensureChannel;
export const androidNotifications: typeof android.service = {
  ...android.service,
  async schedule(input) {
    const due = input.at.getTime();
    diagnostic('alarm.schedule', { due, exact: Number((await exactAlarmStatus()) ?? -1) });
    try {
      const id = await android.service.schedule(input);
      diagnostic('alarm.scheduled', { due, native: 1 });
      return id;
    } catch (error) {
      diagnostic('alarm.error', { due, operation: 1 });
      throw error;
    }
  },
  async cancel(id) {
    await android.service.cancel(id);
    diagnostic('alarm.cancelled');
  },
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false,
  }),
});

export function observeNotifications(
  onOpen: (vehicleId: string | null, taskId: string | null, kind?: 'cold' | 'archive') => void,
  onEvent: (id: string, event: 'opened' | 'received', taskId?: string, vehicleId?: string, due?: number) => void,
): () => void {
  const seen = new Set<string>();
  function open(response: Notifications.NotificationResponse) {
    const request = response.notification.request;
    if (seen.has(request.identifier)) return;
    seen.add(request.identifier);
    const taskId: unknown = request.content.data?.taskId;
    const id: unknown = request.content.data?.vehicleId;
    const valid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
    onEvent(request.identifier, 'opened', valid(taskId) ? taskId : undefined, valid(id) ? id : undefined, nativeTriggerTime(request.trigger) ?? undefined);
    const kind = request.identifier.startsWith('review-cold:') ? 'cold' : request.identifier.startsWith('review-archive:') ? 'archive' : undefined;
    onOpen(valid(id) ? id : null, valid(taskId) ? taskId : null, kind);
    void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
  }
  const listener = Notifications.addNotificationResponseReceivedListener(open);
  const received = Notifications.addNotificationReceivedListener(n => onEvent(n.request.identifier, 'received',
    typeof n.request.content.data?.taskId === 'string' ? n.request.content.data.taskId : undefined,
    typeof n.request.content.data?.vehicleId === 'string' ? n.request.content.data.vehicleId : undefined, nativeTriggerTime(n.request.trigger) ?? undefined));
  const last = Notifications.getLastNotificationResponse();
  if (last) open(last);
  return () => { listener.remove(); received.remove(); };
}
