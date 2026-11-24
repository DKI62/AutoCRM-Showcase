import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAndroidNotifications, type NotificationApi } from '../src/services/notification-service';

function fixture(existing = false) {
  const created: { id: string; options: Parameters<NotificationApi['setNotificationChannelAsync']>[1] }[] = [];
  const scheduled: Parameters<NotificationApi['scheduleNotificationAsync']>[0][] = [];
  const cancelled: string[] = [], dismissed: string[] = [];
  const channels = new Map<string, unknown>();
  let reads = 0, granted = true;
  const api = {
    AndroidImportance: { HIGH: 4 }, SchedulableTriggerInputTypes: { DATE: 'date' },
    async getNotificationChannelAsync(id: string) { reads++; return existing ? { id, sound: null, importance: 0 } : channels.get(id) ?? null; },
    async setNotificationChannelAsync(id: string, options: Parameters<NotificationApi['setNotificationChannelAsync']>[1]) { const channel = { id, ...options }; created.push({ id, options }); channels.set(id, channel); return channel; },
    async getNextTriggerDateAsync(trigger: { date: Date }) { return trigger.date.getTime(); },
    async getAllScheduledNotificationsAsync() { return scheduled.map(item => ({ identifier: item.identifier, trigger: { type: 'date', value: (item.trigger as { date: Date }).date.getTime() } })); },
    async getPermissionsAsync() { return { granted, canAskAgain: false }; },
    async requestPermissionsAsync() { return { granted, canAskAgain: false }; },
    async scheduleNotificationAsync(input: Parameters<NotificationApi['scheduleNotificationAsync']>[0]) { scheduled.push(input); return input.identifier!; },
    async cancelScheduledNotificationAsync(id: string) { cancelled.push(id); }, async dismissNotificationAsync(id: string) { dismissed.push(id); },
  } as unknown as NotificationApi;
  return { ...createAndroidNotifications(api), created, scheduled, cancelled, dismissed, reads: () => reads, deny: () => { granted = false; }, api };
}

test('Android channel omits custom sound, scheduling retains system default; repeated calls create once', async () => {
  const f = fixture();
  await Promise.all([f.ensureChannel(), f.ensureChannel(), f.service.requestPermission()]);
  assert.equal(f.created.length, 1); assert.equal(f.reads(), 1);
  assert.equal(Object.hasOwn(f.created[0]!.options, 'sound'), false);
  assert.equal(f.created[0]!.options.enableVibrate, true);
  await f.service.schedule({ id: 'task-reminder', title: 'Задача', body: 'Авто', at: new Date(Date.now() + 60000), vehicleId: 'vehicle', taskId: 'task' });
  assert.equal(f.scheduled[0]?.content.sound, 'default');
  assert.deepEqual(f.scheduled[0]?.content.data, { vehicleId: 'vehicle', taskId: 'task' });
  assert.equal((f.scheduled[0]?.trigger as { channelId: string }).channelId, f.created[0]?.id);
  assert.equal(f.created.length, 1);
});

test('existing Android channels and user overrides are retained; silent channels explicitly disable sound', async () => {
  const old = fixture(true); await old.ensureChannel(); await old.service.requestPermission();
  assert.equal(old.created.length, 0); assert.equal(old.reads(), 1);
  await assert.rejects(old.service.schedule({ id: 'blocked', title: 'A', body: '', at: new Date(Date.now() + 60000) }), /отключён/);
  const silent = fixture(); await silent.service.schedule({ id: 'silent', title: 'Тихо', body: '', sound: false, vibration: false, at: new Date(Date.now() + 60000) });
  assert.equal(silent.created[0]?.options.sound, null); assert.equal(silent.created[0]?.options.enableVibrate, false);
  assert.equal(silent.scheduled[0]?.content.sound, false);
  assert.equal((silent.scheduled[0]?.trigger as { channelId: string }).channelId, 'reminders-v2-s0-v0');
});

test('real task accepts only its original dueAt and an identifier present in Android', async () => {
  const f = fixture();
  const reminder = { id: 'task', title: 'Задача', body: '', taskId: 'task-id', vehicleId: 'vehicle-id', at: new Date(Date.now() + 120000) };
  f.api.getNextTriggerDateAsync = async () => reminder.at.getTime() + 60000;
  await assert.rejects(f.service.schedule(reminder), /не подтвердил/);
  assert.equal(f.scheduled.length, 0);
  f.api.getNextTriggerDateAsync = async () => reminder.at.getTime();
  f.api.getAllScheduledNotificationsAsync = async () => [];
  await assert.rejects(f.service.schedule(reminder), /списке запланированных/);
  f.api.scheduleNotificationAsync = async () => 'unexpected';
  await assert.rejects(f.service.schedule(reminder), /идентификатор/);
  assert.deepEqual(f.cancelled, ['unexpected']);
  f.api.dismissNotificationAsync = async () => { throw new Error('tray unavailable'); };
  await f.service.cancel('previous');
  assert.deepEqual(f.cancelled, ['unexpected', 'previous']);
});

test('channel creation retries after native failure; denied permission and invalid date never schedule', async () => {
  const f = fixture(); const original = f.api.setNotificationChannelAsync; let attempts = 0;
  f.api.setNotificationChannelAsync = async (...args) => { if (++attempts === 1) throw new Error('native failure'); return original(...args); };
  await assert.rejects(f.ensureChannel(), /native failure/); await f.ensureChannel(); assert.equal(attempts, 2);
  f.deny(); await assert.rejects(f.service.schedule({ id: 'denied', title: 'A', body: '', at: new Date(Date.now() + 60000) }), /разрешения/);
  await assert.rejects(f.service.schedule({ id: 'past', title: 'A', body: '', at: new Date(0) }), /будущее/);
  assert.equal(f.scheduled.length, 0);
  await f.service.cancel('old'); assert.deepEqual(f.cancelled, ['old']); assert.deepEqual(f.dismissed, ['old']);
});
