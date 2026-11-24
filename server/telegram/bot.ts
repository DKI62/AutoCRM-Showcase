import { archiveReasons, digest, reviewKindOf, type RemoteAction, type RemoteTask } from '../../src/services/telegram-protocol';
import { allow, logWebhookFailure, telegram, tokenId } from './bot-api';
import { calendarDeadline, dayKey, parseDeadline } from './local-time';
import type { Environment } from './worker';
import { pairingVersion } from '../../src/services/telegram-pairing';
import { pairingLinkHash, pairingProof } from './pairing';

export interface Device {
  id: string; chat_id: string | null; timezone: string; quiet_start: number; quiet_end: number; public_origin: string; app_scheme: string;
  morning: number; evening: number; overdue: number; cold_days: number; archive_days: number; last_sync: number | null; retry_at: number;
  pairing_version: number; pair_hash: string | null; pair_expires: number | null; pair_request_id: string | null;
  pair_chat_id: string | null; pair_display_name: string | null; pair_username: string | null;
}
export interface Item extends RemoteTask { device_id: string; callback_token: string; callback_expires: number; pending_action: string | null; next_send: number; sent_count: number }
interface Sender { id: number; first_name?: string; last_name?: string; username?: string }
interface Message { message_id?: number; text?: string; chat?: { id: number; type: string }; from?: Sender; reply_to_message?: { message_id: number } }
interface Callback { id: string; data?: string; from?: { id: number }; message?: Message }
interface Update { update_id: number; message?: Message; callback_query?: Callback }
interface Dialog { token: string; task_id: string; revision: number; kind: string; expires: number; due_at: number | null; value: string | null; prompt_id: number | null }
type Button = { text: string; callback_data: string } | { text: string; url: string };
const action = (text: string, command: string, token: string): Button => ({ text, callback_data: `${command}:${token}` });
const archiveLabels = ['Куплено', 'Продано другому', 'Отказ', 'Другая причина'];
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const format = (at: number, timeZone: string) => new Intl.DateTimeFormat('ru-RU', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
const keyboard = (buttons: Button[][]) => ({ inline_keyboard: buttons.filter(row => row.length) });
const owner = (message: Message | undefined, from = message?.from): string | null => {
  const chat = message?.chat;
  return chat?.type === 'private' && Number.isSafeInteger(chat.id) && chat.id > 0 && from?.id === chat.id ? String(chat.id) : null;
};
function link(device: Device, text: string, route: string): Button[] {
  return device.public_origin ? [{ text, url: `${device.public_origin}/open/${route}?app=${device.app_scheme}` }] : [];
}
export function itemMessage(device: Device, item: Item, now: number, overdue = false) {
  const kind = reviewKindOf(item.id);
  const days = Math.max(0, Math.round((now - (item.since ?? now)) / 86400000));
  const buttons: Button[][] = kind === 'cold' ? [
    [action('✓ Актуален', 'keep', item.callback_token), action('🕒 Отложить', 'later', item.callback_token)],
    [action('🚗 В работу', 'promote', item.callback_token), action('📦 В архив', 'archive', item.callback_token)],
  ] : kind === 'archive' ? [
    [action('✓ Оставить', 'keep', item.callback_token), action('🕒 Позже', 'later', item.callback_token)],
    [action('↩ Вернуть', 'restore', item.callback_token), ...(item.vehicle_id ? link(device, '🗑 Удалить…', `vehicle/${item.vehicle_id}`) : [])],
  ] : [[action('✅ Выполнено', 'done', item.callback_token), action('🕒 Перенести', 'move', item.callback_token)]];
  if (item.vehicle_id) buttons.push(link(device, '🚘 Открыть автомобиль', `vehicle/${item.vehicle_id}`));
  const title = kind === 'cold' ? '📞 Проверить актуальность' : kind === 'archive' ? '📦 Проверка архива' : overdue ? '⏰ Просроченная задача' : '🔔 Напоминание';
  const detail = kind ? `Дней ${kind === 'cold' ? 'на этапе «Контакт»' : 'в архиве'}: ${days}`
    : [escape(item.title), format(item.due_at, device.timezone), item.stage && escape(item.stage)].filter(Boolean).join('\n');
  return { text: [title, item.vehicle && `<b>${escape(item.vehicle)}</b>`, detail].filter(Boolean).join('\n\n'), parse_mode: 'HTML', reply_markup: keyboard(buttons) };
}
async function send(env: Environment, device: Device, text: string, buttons: Button[][] = []) {
  return telegram(env, 'sendMessage', { chat_id: Number(device.chat_id), text, ...(buttons.some(row => row.length) ? { reply_markup: keyboard(buttons) } : {}) });
}
async function edit(env: Environment, device: Device, messageId: number | undefined, text: string, buttons: Button[][] = []) {
  if (messageId) await telegram(env, 'editMessageText', { chat_id: device.chat_id, message_id: messageId, text, reply_markup: keyboard(buttons) });
  else await send(env, device, text, buttons);
}
export async function digestMessage(env: Environment, device: Device, now: number, mode: string) {
  const records = (await env.DB.prepare(`SELECT * FROM remote_tasks WHERE device_id=? AND status='pending' AND pending_action IS NULL
    ORDER BY due_at,id`).bind(device.id).all<Item>()).results;
  const day = dayKey(now, device.timezone);
  const tomorrow = calendarDeadline(now, device.timezone, 1, 12);
  const nextDay = tomorrow === null ? day : dayKey(tomorrow, device.timezone);
  const tasks = records.filter(r => !reviewKindOf(r.id));
  const overdue = tasks.filter(r => r.due_at < now);
  const today = tasks.filter(r => dayKey(r.due_at, device.timezone) === day);
  const cold = records.filter(r => reviewKindOf(r.id) === 'cold' && r.due_at <= now);
  const archive = records.filter(r => reviewKindOf(r.id) === 'archive' && r.due_at <= now);
  const chosen = mode === 'overdue' ? overdue : mode === 'today' ? today : mode === 'contact' ? cold : mode === 'archive' ? archive
    : mode === 'evening' ? tasks.filter(r => r.due_at < now || dayKey(r.due_at, device.timezone) <= nextDay) : tasks.filter(r => r.due_at >= now);
  const heading = ({ tasks: 'Ближайшие задачи', today: 'Задачи на сегодня', overdue: 'Просроченные задачи', contact: 'Контакт', archive: 'Проверка архива', morning: '☀️ Утренняя сводка', evening: '🌙 Вечерняя сводка' } as Record<string,string>)[mode]!;
  const shown = chosen.slice(0, 5);
  const lines = shown.map(r => `• ${r.vehicle ? `${r.vehicle} · ` : ''}${r.title} · ${format(r.due_at, device.timezone)}`);
  const text = [heading, `Сегодня: ${today.length} · Просрочено: ${overdue.length} · Контакт: ${cold.length} · Архив: ${archive.length}`, ...lines,
    chosen.length > shown.length ? `Ещё: ${chosen.length - shown.length}` : '', chosen.length ? '' : 'В этом списке пока пусто.'].filter(Boolean).join('\n');
  return { text, shown, buttons: [link(device, 'Задачи в CRM', 'tasks'), link(device, 'Контакт в CRM', 'lots'), link(device, 'Архив в CRM', 'archive')] };
}
async function command(env: Environment, device: Device, name: string, now: number) {
  if (name === 'start' || name === 'help') return send(env, device, 'Auto CRM\n/tasks — ближайшие · /today — сегодня · /overdue — просрочено\n/contact — актуальность · /archive — архив · /status — подключение\n/cancel — отменить текущий ввод');
  if (name === 'status') {
    const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM remote_actions WHERE device_id=? AND outcome IS NULL').bind(device.id).first<{ count: number }>();
    return send(env, device, `Устройство привязано.\nПоследняя синхронизация: ${device.last_sync ? format(device.last_sync, device.timezone) : 'пока нет'}\nОжидают подтверждения телефона: ${row?.count ?? 0}`);
  }
  if (name === 'cancel') {
    await env.DB.prepare('DELETE FROM bot_dialogs WHERE device_id=?').bind(device.id).run();
    return send(env, device, 'Ввод отменён.');
  }
  if (!['tasks','today','overdue','contact','archive'].includes(name)) return send(env, device, 'Доступные команды: /help');
  const view = await digestMessage(env, device, now, name);
  if (view.shown.length) await env.DB.batch(view.shown.map(item =>
    env.DB.prepare('UPDATE remote_tasks SET callback_expires=? WHERE device_id=? AND id=? AND callback_token=?')
      .bind(now + 7 * 86400000, device.id, item.id, item.callback_token)));
  await send(env, device, view.text, [...view.shown.map((item, index) => [
    action(String(index + 1) + '. ' + (item.vehicle ?? item.title).slice(0, 32), 'show', item.callback_token),
  ]), ...view.buttons]);
}
async function openDialog(env: Environment, device: Device, item: Item, kind: string, now: number) {
  const token = tokenId();
  await env.DB.prepare(`INSERT INTO bot_dialogs(device_id,token,task_id,revision,kind,expires) VALUES(?,?,?,?,?,?)
    ON CONFLICT(device_id) DO UPDATE SET token=excluded.token,task_id=excluded.task_id,revision=excluded.revision,kind=excluded.kind,
    expires=excluded.expires,due_at=NULL,value=NULL,prompt_id=NULL,offer_at=NULL`).bind(device.id, token, item.id, item.revision, kind, now + 15 * 60000).run();
  return token;
}
async function queue(env: Environment, device: Device, item: Item, kind: RemoteAction['action'], now: number, update: number,
  messageId: number | undefined, due: number | null = null, value: string | null = null, dialog?: string) {
  const guard = `device_id=? AND id=? AND revision=? AND callback_token=? AND NOT EXISTS(SELECT 1 FROM webhook_updates WHERE id=?)
    AND EXISTS(SELECT 1 FROM devices WHERE id=? AND revoked=0 AND chat_id=?) AND ${kind === 'note' ? "status='done' AND call=1" : "status='pending' AND pending_action IS NULL"}
    ${dialog ? 'AND EXISTS(SELECT 1 FROM bot_dialogs WHERE device_id=remote_tasks.device_id AND token=? AND expires>?)' : ''}`;
  const args = [device.id, item.id, item.revision, item.callback_token, update, device.id, device.chat_id, ...(dialog ? [dialog, now] : [])];
  const statements = [
    env.DB.prepare(`INSERT INTO remote_actions(device_id,task_id,action,due_at,revision,created_at,value,message_id,source_update)
      SELECT device_id,id,?,?,revision,?,?,?,? FROM remote_tasks WHERE ${guard}`).bind(kind, due, now, value, messageId ?? null, update, ...args),
  ];
  if (kind !== 'note') statements.push(env.DB.prepare(`UPDATE remote_tasks SET pending_action=?,callback_token=?,callback_expires=0,
    status=CASE WHEN ?='done' THEN 'done' ELSE status END,due_at=CASE WHEN ?='snooze' THEN ? ELSE due_at END,
    next_send=CASE WHEN ?='snooze' THEN ? ELSE next_send END,sent_count=CASE WHEN ?='snooze' THEN 0 ELSE sent_count END WHERE ${guard}`)
    .bind(kind, tokenId(), kind, kind, due, kind, due, kind, ...args));
  if (dialog) statements.push(env.DB.prepare('DELETE FROM bot_dialogs WHERE device_id=? AND token=?').bind(device.id, dialog));
  if (kind === 'done' && item.call) statements.push(env.DB.prepare(`INSERT INTO bot_dialogs(device_id,token,task_id,revision,kind,expires,offer_at)
    SELECT device_id,?,task_id,revision,'offer_note',?,? FROM remote_actions WHERE source_update=?
    ON CONFLICT(device_id) DO UPDATE SET token=excluded.token,task_id=excluded.task_id,revision=excluded.revision,kind=excluded.kind,
      expires=excluded.expires,offer_at=excluded.offer_at,due_at=NULL,value=NULL,prompt_id=NULL`).bind(tokenId(), now + 15 * 60000, now, update));
  statements.push(env.DB.prepare('INSERT OR IGNORE INTO webhook_updates VALUES(?,?)').bind(update, now));
  return (await env.DB.batch(statements))[0]?.meta.changes === 1;
}
const moveButtons = (token: string) => [
  [action('+15 мин','m15',token), action('+1 час','h1',token), action('+3 часа','h3',token)],
  [action('Завтра 10:00','tom',token), action('Через 3 дня','d3',token)],
  [action('Другая дата','custom',token), action('Отмена','cancel',token)],
];
async function preview(env: Environment, device: Device, dialog: Dialog, due: number, messageId?: number) {
  const token = tokenId();
  const result = await env.DB.prepare("UPDATE bot_dialogs SET kind='confirm_move',token=?,due_at=?,prompt_id=NULL WHERE device_id=? AND token=? AND kind=?")
    .bind(token, due, device.id, dialog.token, dialog.kind).run();
  if (result.meta.changes) await edit(env, device, messageId, `Новый срок: ${format(due, device.timezone)}`, [[action('Подтвердить','confirm',token), action('Отмена','cancel',token)]]);
}
async function prompt(env: Environment, device: Device, dialog: Dialog, kind: string) {
  const next = tokenId();
  const reserved = await env.DB.prepare('UPDATE bot_dialogs SET kind=?,token=?,prompt_id=NULL WHERE device_id=? AND token=? AND expires>?')
    .bind(kind, next, device.id, dialog.token, Date.now()).run();
  if (!reserved.meta.changes) return;
  try {
    const message = await telegram(env, 'sendMessage', { chat_id: device.chat_id,
      text: kind === 'write_note' ? 'Ответьте на это сообщение итогом разговора. /cancel — отменить.' : 'Ответьте датой и временем, например 15.11 14:30. Можно указать год. /cancel — отменить.',
      reply_markup: { force_reply: true } });
    if (message?.message_id) await env.DB.prepare('UPDATE bot_dialogs SET prompt_id=? WHERE device_id=? AND token=?').bind(message.message_id, device.id, next).run();
  } catch (cause) {
    await env.DB.prepare('UPDATE bot_dialogs SET token=?,kind=? WHERE device_id=? AND token=?').bind(dialog.token, dialog.kind, device.id, next).run();
    throw cause;
  }
}
export async function deliverNoteOffer(env: Environment, device: Device, now: number) {
  const dialog = await env.DB.prepare("SELECT * FROM bot_dialogs WHERE device_id=? AND kind='offer_note' AND expires>? AND offer_at<=?")
    .bind(device.id, now, now).first<Dialog>();
  if (!dialog) return;
  const claim = await env.DB.prepare('UPDATE bot_dialogs SET offer_at=? WHERE device_id=? AND token=? AND offer_at<=?')
    .bind(now + 90000, device.id, dialog.token, now).run();
  if (!claim.meta.changes) return;
  await send(env, device, 'Добавить итог разговора?', [[action('📝 Записать','write',dialog.token), action('Пропустить','skip',dialog.token)]]);
  await env.DB.prepare('UPDATE bot_dialogs SET offer_at=NULL WHERE device_id=? AND token=?').bind(device.id, dialog.token).run();
}
async function currentDialog(env: Environment, device: Device, now: number) {
  return env.DB.prepare('SELECT * FROM bot_dialogs WHERE device_id=? AND expires>?').bind(device.id, now).first<Dialog>();
}
async function reply(env: Environment, device: Device, message: Message, update: number, now: number) {
  const dialog = await currentDialog(env, device, now);
  if (!dialog?.prompt_id || dialog.prompt_id !== message.reply_to_message?.message_id) return;
  const text = message.text?.trim();
  if (!text || text.length > 2000) { await send(env, device, 'Введите от 1 до 2000 символов в ответ на запрос.'); return; }
  if (dialog.kind === 'custom_date') {
    const date = parseDeadline(text, now, device.timezone);
    if (date === null) await send(env, device, 'Укажите однозначное будущее время в формате 15.11 14:30. Ответьте на первоначальный запрос.');
    else await preview(env, device, dialog, date);
  } else if (dialog.kind === 'write_note') {
    const item = await env.DB.prepare("SELECT * FROM remote_tasks WHERE device_id=? AND id=? AND status='done' AND call=1").bind(device.id, dialog.task_id).first<Item>();
    if (item && await queue(env, device, item, 'note', now, update, undefined, null, text, dialog.token)) {
      await send(env, device, 'Итог принят. Подтвержу после сохранения на телефоне.');
    } else await send(env, device, 'Задача изменилась. Итог не отправлен.');
  }
}
async function handleCallback(env: Environment, device: Device, callback: Callback, update: number, now: number) {
  const match = /^([a-z0-9]{2,12}):([a-f0-9]{32})$/.exec(callback.data ?? '');
  if (!match) return;
  const [, code, token] = match;
  const messageId = callback.message?.message_id;
  const dialog = await currentDialog(env, device, now);
  if (dialog && dialog.token === token) {
    const item = await env.DB.prepare(`SELECT * FROM remote_tasks WHERE device_id=? AND id=? AND
      (revision=? OR (?='offer_note' AND status='done' AND call=1))`).bind(device.id, dialog.task_id, dialog.revision, dialog.kind).first<Item>();
    if (code === 'cancel' || code === 'skip') {
      await env.DB.prepare('DELETE FROM bot_dialogs WHERE device_id=? AND token=?').bind(device.id, dialog.token).run();
      await edit(env, device, messageId, code === 'skip' ? 'Итог пропущен. Задача отправлена на телефон.' : 'Ввод отменён.');
    } else if (item && code === 'write' && dialog.kind === 'offer_note') await prompt(env, device, dialog, 'write_note');
    else if (item && dialog.kind === 'move' && code === 'custom') await prompt(env, device, dialog, 'custom_date');
    else if (item && dialog.kind === 'move' && code && ['m15','h1','h3','tom','d3'].includes(code)) {
      const minutes = ({ m15: 15, h1: 60, h3: 180 } as Record<string, number>)[code];
      const due = minutes ? Math.ceil(now / 60000) * 60000 + minutes * 60000 : calendarDeadline(now, device.timezone, code === 'tom' ? 1 : 3, code === 'tom' ? 10 : undefined);
      if (due !== null) await preview(env, device, dialog, due, messageId);
      else await edit(env, device, messageId, 'Это время неоднозначно. Выберите другую дату.', moveButtons(dialog.token));
    } else if (item && dialog.kind === 'archive' && /^r[0-3]$/.test(code ?? '')) {
      const index = Number(code![1]);
      const confirmation = tokenId();
      const reserved = await env.DB.prepare("UPDATE bot_dialogs SET kind='confirm_archive',value=?,token=? WHERE device_id=? AND token=? AND kind='archive'")
        .bind(archiveReasons[index]!, confirmation, device.id, dialog.token).run();
      if (reserved.meta.changes) await edit(env, device, messageId, `Перенести в архив? ${archiveLabels[index]}`,
        [[action('Подтвердить','confirm',confirmation), action('Отмена','cancel',confirmation)]]);
    } else if (item && code === 'confirm' && dialog.kind === 'confirm_move' && dialog.due_at !== null && dialog.due_at > now) {
      if (await queue(env, device, item, 'snooze', now, update, messageId, dialog.due_at, null, dialog.token)) {
        await edit(env, device, messageId, `🕒 Перенесено на ${format(dialog.due_at, device.timezone)}. Ожидает подтверждения телефона.`);
      }
    } else if (item && code === 'confirm' && dialog.kind === 'confirm_archive' && dialog.value) {
      if (await queue(env, device, item, 'archive', now, update, messageId, null, dialog.value, dialog.token)) {
        await edit(env, device, messageId, '📦 Перенос в архив ожидает подтверждения телефона.');
      }
    } else await edit(env, device, messageId, 'Действие устарело. Откройте актуальный список через /help.');
    return;
  }
  const item = await env.DB.prepare(`SELECT * FROM remote_tasks WHERE device_id=? AND callback_token=? AND callback_expires>?
    AND status='pending' AND pending_action IS NULL`).bind(device.id, token!, now).first<Item>();
  if (!item) {
    // A retry of the original callback must not erase the confirmation it already produced.
    if (!await env.DB.prepare('SELECT seq FROM remote_actions WHERE device_id=? AND message_id=? LIMIT 1').bind(device.id, messageId ?? null).first()
      && !await env.DB.prepare('SELECT id FROM webhook_updates WHERE id=?').bind(update).first()) {
      await edit(env, device, messageId, 'Кнопка устарела. Актуальные задачи: /tasks. Проверки: /contact и /archive.');
    }
    return;
  }
  const kind = reviewKindOf(item.id);
  if (code === 'show') {
    await telegram(env, messageId ? 'editMessageText' : 'sendMessage', { chat_id: device.chat_id,
      ...(messageId ? { message_id: messageId } : {}), ...itemMessage(device, item, now, !kind && item.due_at < now) });
  } else if (!kind && code === 'move') {
    const key = await openDialog(env, device, item, 'move', now);
    await edit(env, device, messageId, `Перенести «${item.title}»`, moveButtons(key));
  } else if (kind === 'cold' && code === 'archive') {
    const key = await openDialog(env, device, item, 'archive', now);
    await edit(env, device, messageId, 'Причина переноса в архив', archiveLabels.map((label, index) => [action(label,`r${index}`,key)]).concat([[action('Отмена','cancel',key)]]));
  } else if (kind === 'cold' && code === 'promote' && !item.promotable) {
    await send(env, device, 'В карточке укажите оценку выкупа, рынок и следующее действие.', [link(device, 'Открыть автомобиль', `vehicle/${item.vehicle_id}`)]);
  } else if ((!kind && code === 'done') || (kind && (code === 'keep' || code === 'later')) ||
    (kind === 'cold' && code === 'promote') || (kind === 'archive' && code === 'restore')) {
    const due = code === 'later' ? calendarDeadline(now, device.timezone, kind === 'cold' ? device.cold_days : device.archive_days) : null;
    if (code === 'later' && due === null) { await send(env, device, 'Не удалось выбрать однозначное время. Откройте карточку в CRM.'); return; }
    if (!await queue(env, device, item, code as RemoteAction['action'], now, update, messageId, due)) return;
    await edit(env, device, messageId, `${code === 'done' ? '✅ Выполнено в Telegram' : '✓ Действие принято'}. Ожидает подтверждения телефона.`).catch(logWebhookFailure);
    if (code === 'done' && item.call) await deliverNoteOffer(env, device, now).catch(logWebhookFailure);
  }
}

async function pairingReply(env: Environment, chat: string, code: string, scope: string, now: number, from?: Sender) {
  const hash = await pairingLinkHash(env, code);
  const getPending = () => env.DB.prepare(`SELECT pair_request_id FROM devices WHERE pair_hash=? AND pair_expires>?
    AND revoked=0 AND chat_id IS NULL AND pairing_version=? AND pair_chat_id=?`)
    .bind(hash, Date.now(), pairingVersion, chat).first<{ pair_request_id: string }>();
  let pending = await getPending();
  if (!pending && await allow(env, `bind:${scope}`, 5, 3600000)) {
    const names = [from?.first_name, from?.last_name].filter(name => typeof name === 'string');
    const name = names.join(' ').replace(/\p{C}/gu, '').trim().slice(0, 96) || null;
    const username = typeof from?.username === 'string' && /^[a-zA-Z0-9_]{1,32}$/.test(from.username) ? from.username : null;
    await env.DB.prepare(`UPDATE devices SET pair_chat_id=?,pair_request_id=?,pair_display_name=?,pair_username=?
      WHERE pair_hash=? AND pair_expires>? AND pairing_version=? AND revoked=0 AND chat_id IS NULL AND pair_request_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM devices WHERE chat_id=? AND revoked=0)`)
      .bind(chat, crypto.randomUUID(), name, username, hash, now, pairingVersion, chat).run();
    pending = await getPending();
  }
  await telegram(env, 'sendMessage', { chat_id: Number(chat), text: pending
    ? `Код подтверждения Auto CRM: ${await pairingProof(env, pending.pair_request_id, chat)}\nВведите его лично в Настройки → Telegram в приложении. Никому не пересылайте код.`
    : 'Не удалось использовать ссылку. Проверьте подключение в Настройки → Telegram в Auto CRM.' });
}

export class WebhookInProgress extends Error {}

async function handleCommand(env: Environment, chat: string, name: string, pairCode: string | undefined, scope: string, id: number, now: number, from?: Sender) {
  // Negative timestamps are temporary claims. Positive timestamps mean the reply was sent.
  const claim = -now;
  const reserved = await env.DB.prepare(`INSERT INTO webhook_updates VALUES(?,?) ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at
    WHERE webhook_updates.created_at<0 AND webhook_updates.created_at>=?`).bind(id, claim, -(now - 30000)).run();
  if (!reserved.meta.changes) {
    const existing = await env.DB.prepare('SELECT created_at FROM webhook_updates WHERE id=?').bind(id).first<{ created_at: number }>();
    if (existing && existing.created_at >= 0) return;
    throw new WebhookInProgress();
  }
  try {
    if (pairCode) await pairingReply(env, chat, pairCode, scope, now, from);
    else {
      const device = await env.DB.prepare('SELECT * FROM devices WHERE chat_id=? AND revoked=0').bind(chat).first<Device>();
      if (device) await command(env, device, name, now);
      else await telegram(env, 'sendMessage', { chat_id: Number(chat),
        text: 'Подключите Auto CRM: откройте Настройки → Telegram, нажмите «Подключить Telegram» и запустите бота по ссылке из приложения.' });
    }
    await env.DB.prepare('UPDATE webhook_updates SET created_at=? WHERE id=? AND created_at=?').bind(Date.now(), id, claim).run();
  } catch (cause) {
    await env.DB.prepare('DELETE FROM webhook_updates WHERE id=? AND created_at=?').bind(id, claim).run();
    throw cause;
  }
}

export async function processUpdate(env: Environment, update: Update) {
  if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) return false;
  const callback = update.callback_query, message = update.message;
  const chat = callback ? owner(callback.message, callback.from) : owner(message);
  if (!chat) return true;
  const now = Date.now(), id = update.update_id;
  if (callback && (typeof callback.id !== 'string' || callback.id.length > 128)) return true;
  const existing = await env.DB.prepare('SELECT created_at FROM webhook_updates WHERE id=?').bind(id).first<{ created_at: number }>();
  if (existing && existing.created_at >= 0) return true;
  if (existing && -existing.created_at > now - 30000) throw new WebhookInProgress();
  const scope = await digest(env.FIXTURE_PAIRING_PEPPER + chat);
  if (!await allow(env, `chat:${scope}`, 35)) return true;
  const text = typeof message?.text === 'string' ? message.text : '';
  const cmd = /^\/([a-z0-9_]{1,32})(?:@([a-z0-9_]+))?(?=\s|$)/i.exec(text);
  if (!callback && cmd) {
    if (cmd[2] && cmd[2].toLowerCase() !== env.FIXTURE_BOT_NAME.toLowerCase()) return true;
    const name = cmd[1]!.toLowerCase();
    const pairCode = name === 'start' ? /^pair2_([a-f0-9]{32})$/.exec(text.slice(cmd[0].length).trim())?.[1] : undefined;
    await handleCommand(env, chat, name, pairCode, scope, id, now, message?.from);
    return true;
  }
  if (callback) await telegram(env, 'answerCallbackQuery', { callback_query_id: callback.id }).catch(logWebhookFailure);
  const device = await env.DB.prepare('SELECT * FROM devices WHERE chat_id=? AND revoked=0').bind(chat).first<Device>();
  if (!device) return true;
  if (callback) await handleCallback(env, device, callback, id, now);
  else if (message && text) await reply(env, device, message, id, now);
  await env.DB.prepare('INSERT OR IGNORE INTO webhook_updates VALUES(?,?)').bind(id, now).run();
  return true;
}
