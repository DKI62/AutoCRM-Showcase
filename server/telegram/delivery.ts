import { quietNow, reviewKindOf } from '../../src/services/telegram-protocol';
import { TelegramFailure, telegram } from './bot-api';
import { deliverNoteOffer, digestMessage, itemMessage, type Device, type Item } from './bot';
import { dayKey, wallTime } from './local-time';
import type { Environment } from './worker';

const minute = 60000, lease = 90000, never = 8640000000000000;
const retry = (error: unknown) => error instanceof TelegramFailure ? error.retryMs : minute;
const permanent = (error: unknown) => error instanceof TelegramFailure && error.permanent;

async function deliveryFailure(env: Environment, device: Device, cause: unknown, now: number) {
  if (cause instanceof TelegramFailure && !cause.permanent) {
    await env.DB.prepare('UPDATE devices SET retry_at=MAX(retry_at,?) WHERE id=?').bind(now + cause.retryMs, device.id).run();
    device.retry_at = now + cause.retryMs;
  }
}

async function sendItems(env: Environment, device: Device, now: number) {
  const items = (await env.DB.prepare(`SELECT * FROM remote_tasks WHERE device_id=? AND status='pending' AND pending_action IS NULL
    AND next_send<=? ORDER BY next_send,id LIMIT 8`).bind(device.id, now).all<Item>()).results;
  for (const item of items) {
    if (device.retry_at > now) break;
    const repeat = !reviewKindOf(item.id) && !!device.overdue && item.sent_count === 0;
    const limit = !reviewKindOf(item.id) && device.overdue ? 2 : 1;
    const claimed = await env.DB.prepare(`UPDATE remote_tasks SET next_send=?,callback_expires=?
      WHERE device_id=? AND id=? AND callback_token=? AND status='pending' AND pending_action IS NULL AND next_send<=? AND sent_count=?`)
      .bind(now + lease, now + 7 * 86400000, device.id, item.id, item.callback_token, now, item.sent_count).run();
    if (!claimed.meta.changes) continue;
    let next = never, count = item.sent_count;
    try {
      if (count < limit) {
        await telegram(env, 'sendMessage', { chat_id: device.chat_id, ...itemMessage(device, item, now, count > 0) });
        count++;
        if (repeat) next = Math.max(now, item.due_at) + 30 * minute;
      }
    } catch (cause) {
      next = permanent(cause) ? never : now + retry(cause);
      await deliveryFailure(env, device, cause, now);
    }
    await env.DB.prepare("UPDATE remote_tasks SET next_send=?,sent_count=? WHERE device_id=? AND id=? AND status='pending' AND pending_action IS NULL AND due_at=? AND next_send=?")
      .bind(next, count, device.id, item.id, item.due_at, now + lease).run();
  }
}

async function sendDigests(env: Environment, device: Device, now: number) {
  const { hour } = wallTime(now, device.timezone);
  for (const mode of ['morning','evening'] as const) {
    if (device[mode] !== hour || device.retry_at > now) continue;
    const slot = `${dayKey(now, device.timezone)}:${mode}`;
    const row = await env.DB.prepare(`INSERT INTO bot_digests VALUES(?,?,?,0) ON CONFLICT(device_id,slot)
      DO UPDATE SET retry_at=excluded.retry_at WHERE sent=0 AND retry_at<=?`).bind(device.id, slot, now + lease, now).run();
    if (!row.meta.changes) continue;
    try {
      const view = await digestMessage(env, device, now, mode);
      await telegram(env, 'sendMessage', { chat_id: device.chat_id, text: view.text, reply_markup: { inline_keyboard: view.buttons.filter(buttons => buttons.length) } });
      await env.DB.prepare('UPDATE bot_digests SET sent=1 WHERE device_id=? AND slot=?').bind(device.id, slot).run();
    } catch (cause) {
      await deliveryFailure(env, device, cause, now);
      await env.DB.prepare('UPDATE bot_digests SET retry_at=? WHERE device_id=? AND slot=?').bind(permanent(cause) ? never : now + retry(cause), device.id, slot).run();
    }
  }
}

async function sendReceipts(env: Environment, device: Device, now: number) {
  const rows = (await env.DB.prepare(`SELECT seq,action,due_at,outcome,message_id FROM remote_actions WHERE device_id=? AND notice_at<=?
    ORDER BY seq LIMIT 8`).bind(device.id, now).all<{ seq: number; action: string; due_at: number | null; outcome: string; message_id: number | null }>()).results;
  for (const row of rows) {
    if (device.retry_at > now) break;
    const claim = await env.DB.prepare('UPDATE remote_actions SET notice_at=? WHERE device_id=? AND seq=? AND notice_at<=?')
      .bind(now + lease, device.id, row.seq, now).run();
    if (!claim.meta.changes) continue;
    let next: number | null = null;
    const text = row.outcome === 'conflict' ? 'Данные в CRM изменились. Действие не применено. Откройте актуальный список через /help.'
      : row.action === 'note' ? '📝 Итог разговора сохранён в CRM.'
        : row.action === 'snooze' && row.due_at !== null ? `🕒 Срок сохранён в CRM: ${new Date(row.due_at).toLocaleString('ru-RU', { timeZone: device.timezone })}`
          : row.action === 'done' ? '✅ Выполнение подтверждено в CRM.' : '✓ Изменение подтверждено в CRM.';
    try {
      await telegram(env, row.message_id ? 'editMessageText' : 'sendMessage',
        { chat_id: device.chat_id, ...(row.message_id ? { message_id: row.message_id, reply_markup: { inline_keyboard: [] } } : {}), text });
    } catch (cause) {
      // A removed or uneditable Telegram message must not leave a receipt in a retry loop.
      if (!permanent(cause)) { next = now + retry(cause); await deliveryFailure(env, device, cause, now); }
    }
    await env.DB.prepare('UPDATE remote_actions SET notice_at=? WHERE device_id=? AND seq=? AND notice_at=?')
      .bind(next, device.id, row.seq, now + lease).run();
  }
}

export async function sendDue(env: Environment, now = Date.now()) {
  if (!env.telegramFixture || !env.FIXTURE_PAIRING_PEPPER) return;
  const devices = (await env.DB.prepare(`SELECT * FROM devices WHERE revoked=0 AND chat_id IS NOT NULL AND retry_at<=?
    ORDER BY id`).bind(now).all<Device>()).results;
  for (const device of devices) {
    if (quietNow(now, device.timezone, device.quiet_start, device.quiet_end)) continue;
    await sendItems(env, device, now);
    if (device.retry_at <= now) await deliverNoteOffer(env, device, now).catch(cause => deliveryFailure(env, device, cause, now));
    await sendReceipts(env, device, now);
    await sendDigests(env, device, now);
  }
  const before = now - 30 * 86400000;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM webhook_updates WHERE ABS(created_at)<?').bind(before),
    env.DB.prepare('DELETE FROM bot_dialogs WHERE expires<=?').bind(now),
    env.DB.prepare('DELETE FROM devices WHERE chat_id IS NULL AND pair_expires<?').bind(now - 86400000),
    env.DB.prepare('DELETE FROM bot_digests WHERE slot<?').bind(String(dayKey(before, 'UTC'))),
    env.DB.prepare('DELETE FROM bot_limits WHERE window<? AND (scope LIKE ? OR scope LIKE ?)').bind(Math.floor(before / minute), 'chat:%', 'device:%'),
    env.DB.prepare('DELETE FROM bot_limits WHERE window<? AND (scope LIKE ? OR scope LIKE ?)').bind(Math.floor(before / 3600000), 'bind:%', 'pair:%'),
  ]);
}
