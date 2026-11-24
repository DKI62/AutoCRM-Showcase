import * as Notifications from 'expo-notifications';
import { androidNotifications } from './notifications';
import { createReminderReconciler } from './reminder-reconciler';
import { nativeTriggerTime } from './notification-service';
import { exactAlarmStatus } from './alarm-access';
import { diagnostic } from './diagnostics';

export const reconcileReminders = createReminderReconciler({
  async prepare(repository) {
    const exact = await exactAlarmStatus();
    if (exact === null) return;
    const current = await repository.getSetting('notification_exact');
    const next = exact ? 'on' : 'off';
    if (current === next) return;
    diagnostic('alarm.permission', { exact: Number(exact) });
    // Android can remove previously scheduled exact alarms when access is revoked.
    if (exact || current === 'on') await repository.rescheduleAllReminders({ key: 'notification_exact', value: next });
    else await repository.setSetting('notification_exact', next);
  },
  schedule: input => androidNotifications.schedule(input),
  cancel: id => androidNotifications.cancel(id),
  list: async () => (await Notifications.getAllScheduledNotificationsAsync()).map(item => ({ id: item.identifier, at: nativeTriggerTime(item.trigger) })),
}, true, diagnostic);
