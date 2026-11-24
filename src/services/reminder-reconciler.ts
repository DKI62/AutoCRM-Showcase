import type { CrmRepository } from '../repositories/crm-repository';
import type { NotificationService } from './notification-service';
import type { DiagnosticEvent, DiagnosticValues } from './diagnostic-format';

export function createReminderReconciler(api: Pick<NotificationService, 'schedule' | 'cancel'> & { list(): Promise<(string | { id: string; at: number | null })[]>; prepare?(repository: CrmRepository): Promise<void> }, includeReviews = false,
  report: (event: DiagnosticEvent, values?: DiagnosticValues) => void = () => {}) {
  let running: Promise<void> | null = null;
  let again = false;
  return function reconcileReminders(repository: CrmRepository): Promise<void> {
    again = true;
    if (running) return running;
    running = (async () => {
      do {
        again = false;
        await api.prepare?.(repository);
        // Read both sets together so a concurrent reschedule can't appear without its cancellation.
        const { cancellations, reminders } = await repository.reminderQueue(includeReviews);
        const blockedTasks = new Set<string>();
        let blockedLegacyCancellation = false;
        for (const entry of cancellations) {
          try {
            await api.cancel(entry.provider_id);
            await repository.recordNotification('android', entry.provider_id, 'cancelled');
            await repository.confirmCancellation(entry.provider_id);
          } catch {
            report('alarm.error', { operation: 2 });
            if (entry.task_id) blockedTasks.add(entry.task_id);
            else blockedLegacyCancellation = true; // No reliable association for rows from older versions.
          }
        }
        if (blockedLegacyCancellation) continue;
        const future = reminders.filter(reminder => reminder.due_at > Date.now() && !blockedTasks.has(reminder.task_id));
        if (!future.length && !includeReviews) continue;
        let scheduled: Map<string, number | null>;
        try { scheduled = new Map((await api.list()).map(item => typeof item === 'string' ? [item, null] : [item.id, item.at])); }
        catch {
          report('alarm.error', { operation: 3 });
          for (const reminder of reminders) if (reminder.due_at > Date.now() && !blockedTasks.has(reminder.task_id))
            await repository.reminderResult(reminder.provider_id, 'Не удалось прочитать очередь Android. Повторим проверку.');
          continue;
        }
        report('alarm.snapshot', { native: scheduled.size, local: future.length,
          count: future.filter(reminder => !scheduled.has(reminder.provider_id) || (scheduled.get(reminder.provider_id) != null && scheduled.get(reminder.provider_id) !== reminder.due_at)).length });
        if (!future.length) continue;
        const sound = (await repository.getSetting('notification_sound')) !== 'off';
        const vibration = (await repository.getSetting('notification_vibration')) !== 'off';
        for (const reminder of reminders) {
          if (reminder.due_at <= Date.now() || blockedTasks.has(reminder.task_id)) continue;
          const at = scheduled.get(reminder.provider_id);
          if (at != null && at !== reminder.due_at) {
            try { await api.cancel(reminder.provider_id); scheduled.delete(reminder.provider_id); }
            catch { await repository.reminderResult(reminder.provider_id, 'Не удалось отменить неверное системное время.'); continue; }
          }
          if (scheduled.has(reminder.provider_id) && reminder.state === 'scheduled') continue;
          if (!scheduled.has(reminder.provider_id)) {
            if (reminder.state === 'scheduled') report('alarm.missing', { due: reminder.due_at });
            try {
              const target = reminder.vehicle_id ? { vehicleId: reminder.vehicle_id, taskId: reminder.task_id } : {};
              await api.schedule({ id: reminder.provider_id, title: reminder.title, body: reminder.vehicle_title,
                at: new Date(reminder.due_at), ...target, sound, vibration });
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Ошибка Android уведомления.';
              if (reminder.state !== 'error' || reminder.error !== message) await repository.reminderResult(reminder.provider_id, message);
              continue;
            }
          }
          await repository.recordNotification('android', reminder.provider_id, 'scheduled', reminder.vehicle_id ? reminder.task_id : undefined, reminder.vehicle_id ?? undefined);
          if (!(await repository.reminderResult(reminder.provider_id, null))) await api.cancel(reminder.provider_id);
        }
      } while (again);
    })().finally(() => { running = null; });
    return running;
  };
}
