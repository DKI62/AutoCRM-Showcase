import { digest, isUuid, quietNow, validTask, type Receipt } from '../../src/services/telegram-protocol';
import { allow, logWebhookFailure, telegram, tokenId } from './bot-api';
import { processUpdate, WebhookInProgress, type Device } from './bot';
import { sendDue } from './delivery';
import { pairingCodePattern, pairingVersion } from '../../src/services/telegram-pairing';
import { pairingLinkHash, pairingProof } from './pairing';

export interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface ServerDatabase { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<{ meta: { changes: number } }[]> }
export interface Environment { DB: ServerDatabase; telegramFixture?: (url: string, init: RequestInit) => Promise<Response>; FIXTURE_BOT_NAME: string; FIXTURE_WEBHOOK_KEY: string; FIXTURE_PAIRING_PEPPER: string }
export { sendDue };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
class InputError extends Error {}
async function body(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new InputError('Empty body');
  const decoder = new TextDecoder();
  let length = 0, text = '';
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.byteLength;
    if (length > 64000) { await reader.cancel(); throw new InputError('Request too large'); }
    text += decoder.decode(part.value, { stream: true });
  }
  try { return JSON.parse(text + decoder.decode()); }
  catch { throw new InputError('Invalid JSON'); }
}
function appScheme(value: unknown) { return value === 'autocrm-showcase-dev' ? 'autocrm-showcase-dev' : 'autocrm-showcase'; }
function openApp(url: URL) {
  const route = url.pathname.slice('/open/'.length);
  const [kind, id, extra] = route.split('/');
  if (extra !== undefined || (id ? !['vehicle','task'].includes(kind!) || !isUuid(id) : !['lots','tasks','archive'].includes(kind!))) return json({ error: 'Not found' }, 404);
  const href = `${appScheme(url.searchParams.get('app'))}://${route}`;
  return new Response(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Auto CRM</title><h1>Auto CRM</h1><p><a href="${href}">Открыть в приложении</a></p></html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'" },
  });
}
async function pair(request: Request, url: URL, env: Environment) {
  const data = request.body ? await body(request) as { app?: unknown; pairingVersion?: unknown } | null : null;
  if (data?.pairingVersion !== pairingVersion) return json({ error: 'Update Auto CRM to link Telegram' }, 426);
  const ip = await digest(env.FIXTURE_PAIRING_PEPPER + (request.headers.get('CF-Connecting-IP') ?? 'unknown'));
  if (!await allow(env, `pair:${ip}`, 5, 3600000)) return json({ error: 'Try later' }, 429);
  const token = tokenId() + tokenId(), code = tokenId(), id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO devices(id,token_hash,pair_hash,pair_expires,public_origin,app_scheme,pairing_version) VALUES(?,?,?,?,?,?,?)')
    .bind(id, await digest(token), await pairingLinkHash(env, code), Date.now() + 10 * 60000, url.origin, appScheme(data.app), pairingVersion).run();
  return json({ pairingVersion, deviceId: id, deviceToken: token, bindUrl: `https://telegram.fixture.invalid/${env.FIXTURE_BOT_NAME}?start=pair2_${code}` });
}

function deviceStatus(device: Device) {
  if (device.chat_id || device.pairing_version !== pairingVersion) return { linked: !!device.chat_id };
  if (!device.pair_expires || device.pair_expires <= Date.now()) return { linked: false, pairingState: 'expired' };
  if (!device.pair_hash) return { linked: false, pairingState: 'rejected' };
  if (!device.pair_request_id) return { linked: false, pairingState: 'waiting' };
  return { linked: false, pairingState: 'pending', candidate: {
    requestId: device.pair_request_id, displayName: device.pair_display_name, username: device.pair_username,
  } };
}

async function decidePairing(request: Request, env: Environment, device: Device) {
  const decision = await body(request) as { requestId?: unknown; approve?: unknown; code?: unknown } | null;
  if (!decision || !isUuid(decision.requestId) || typeof decision.approve !== 'boolean') return json({ error: 'Invalid decision' }, 400);
  if (device.pairing_version !== pairingVersion || device.pair_request_id !== decision.requestId) return json({ error: 'Pairing request changed' }, 409);
  if (!decision.approve) {
    if (device.chat_id) return json({ error: 'Already linked' }, 409);
    const result = await env.DB.prepare(`UPDATE devices SET pair_hash=NULL,pair_chat_id=NULL,pair_display_name=NULL,pair_username=NULL
      WHERE id=? AND pair_request_id=? AND chat_id IS NULL AND revoked=0`).bind(device.id, decision.requestId).run();
    return result.meta.changes === 1 ? json({ rejected: true }) : json({ error: 'Pairing request changed' }, 409);
  }
  const chat = device.chat_id ?? device.pair_chat_id;
  if (!chat || (!device.chat_id && (!device.pair_expires || device.pair_expires <= Date.now())))
    return json({ error: 'Pairing expired or rejected' }, 409);
  if (typeof decision.code !== 'string' || !pairingCodePattern.test(decision.code)) return json({ error: 'Invalid confirmation code' }, 400);
  if (decision.code !== await pairingProof(env, decision.requestId, chat)) return json({ error: 'Incorrect confirmation code' }, 403);
  if (device.chat_id) return json({ linked: true });
  const linked = await env.DB.prepare(`UPDATE devices SET chat_id=pair_chat_id,pair_hash=NULL,pair_expires=NULL,
      pair_chat_id=NULL,pair_display_name=NULL,pair_username=NULL
    WHERE id=? AND revoked=0 AND chat_id IS NULL AND pairing_version=? AND pair_request_id=? AND pair_chat_id=? AND pair_expires>?
      AND NOT EXISTS(SELECT 1 FROM devices WHERE chat_id=? AND revoked=0)`)
    .bind(device.id, pairingVersion, decision.requestId, chat, Date.now(), chat).run();
  if (linked.meta.changes === 1) return json({ linked: true });
  // A concurrent retry of the same decision can observe the committed result.
  const accepted = await env.DB.prepare('SELECT id FROM devices WHERE id=? AND revoked=0 AND chat_id=? AND pair_request_id=?')
    .bind(device.id, chat, decision.requestId).first();
  return accepted ? json({ linked: true }) : json({ error: 'Pairing request changed or chat already in use' }, 409);
}
async function upload(request: Request, env: Environment, device: Device) {
  const tasks = await body(request);
  if (!Array.isArray(tasks) || tasks.length > 40 || !tasks.every(validTask) || new Set(tasks.map(task => task.id)).size !== tasks.length)
    return json({ error: 'Invalid task contract' }, 400);
  if (tasks.length) {
    await env.DB.batch(tasks.map(task => env.DB.prepare(`INSERT INTO remote_tasks(
        device_id,id,title,due_at,revision,status,next_send,callback_token,vehicle_id,vehicle,stage,call,since,promotable)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM devices WHERE id=? AND chat_id IS NOT NULL AND revoked=0)
      ON CONFLICT(device_id,id) DO UPDATE SET title=excluded.title,due_at=excluded.due_at,revision=excluded.revision,
        status=excluded.status,pending_action=NULL,callback_token=excluded.callback_token,callback_expires=0,vehicle_id=excluded.vehicle_id,
        vehicle=excluded.vehicle,stage=excluded.stage,call=excluded.call,since=excluded.since,promotable=excluded.promotable,
        next_send=CASE WHEN remote_tasks.due_at!=excluded.due_at OR remote_tasks.status!=excluded.status THEN excluded.next_send ELSE remote_tasks.next_send END,
        sent_count=CASE WHEN remote_tasks.due_at!=excluded.due_at OR remote_tasks.status!=excluded.status THEN 0 ELSE remote_tasks.sent_count END
      WHERE excluded.revision>remote_tasks.revision AND (remote_tasks.pending_action IS NULL OR NOT EXISTS(
        SELECT 1 FROM remote_actions a WHERE a.device_id=remote_tasks.device_id AND a.task_id=remote_tasks.id AND a.action!='note' AND a.outcome IS NULL))`).bind(device.id, task.id, task.title.trim(), task.due_at,
      task.revision, task.status, task.due_at, tokenId(), task.vehicle_id ?? null, task.vehicle ?? null, task.stage ?? null,
      Number(!!task.call), task.since ?? null, Number(!!task.promotable), device.id)));
    const saved = (await env.DB.prepare(`SELECT id,revision FROM remote_tasks WHERE device_id=? AND id IN (${tasks.map(() => '?').join(',')})`)
      .bind(device.id, ...tasks.map(task => task.id)).all<{ id: string; revision: number }>()).results;
    const revisions = new Map(saved.map(row => [row.id, row.revision]));
    if (tasks.some(task => revisions.get(task.id) !== task.revision)) return json({ error: 'Sync actions before retrying tasks' }, 409);
  }
  await env.DB.prepare('UPDATE devices SET last_sync=? WHERE id=?').bind(Date.now(), device.id).run();
  return json({ accepted: true });
}
const sequence = (seq: unknown): seq is number => typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0;
function validReceipt(value: unknown): value is Receipt {
  if (!value || typeof value !== 'object') return false;
  const { seq, state } = value as Receipt;
  return sequence(seq) && seq > 0 && (state === 'applied' || state === 'conflict');
}
async function acknowledge(request: Request, env: Environment, device: Device) {
  const payload = await body(request) as number | { seq?: unknown; outcomes?: unknown } | null;
  const legacy = typeof payload === 'number';
  const seq = legacy ? payload : payload?.seq;
  const outcomes = typeof payload === 'object' && payload ? payload.outcomes : null;
  if (!sequence(seq) || (!legacy && (!Array.isArray(outcomes) || outcomes.length > 100 ||
    !outcomes.every(row => validReceipt(row) && row.seq <= seq)))) return json({ error: 'Invalid acknowledgement' }, 400);
  const receipts = Array.isArray(outcomes) ? outcomes as Receipt[] : [];
  const statements = receipts.map(row => env.DB.prepare(`UPDATE remote_actions SET outcome=?,notice_at=0,value=NULL
    WHERE device_id=? AND seq=? AND outcome IS NULL`).bind(row.state, device.id, row.seq));
  if (legacy) statements.push(env.DB.prepare(`UPDATE remote_actions SET outcome='legacy',value=NULL WHERE device_id=? AND seq<=? AND outcome IS NULL AND action IN ('done','snooze')`)
    .bind(device.id, seq));
  if (statements.length) await env.DB.batch(statements);
  return json({ ok: true });
}
async function preferences(request: Request, env: Environment, device: Device) {
  const value = await body(request) as { timezone?: unknown; start?: unknown; end?: unknown; morning?: unknown; evening?: unknown; overdue?: unknown; coldDays?: unknown; archiveDays?: unknown; app?: unknown } | null;
  const hours = (n: unknown, min: number) => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= 23;
  if (!value || typeof value.timezone !== 'string' || value.timezone.length > 64 || !hours(value.start, 0) || !hours(value.end, 0)
    || (value.morning !== undefined && !hours(value.morning, -1)) || (value.evening !== undefined && !hours(value.evening, -1))
    || (value.overdue !== undefined && typeof value.overdue !== 'boolean')
    || (value.coldDays !== undefined && ![0,7,14,30].includes(value.coldDays as number))
    || (value.archiveDays !== undefined && ![0,7,14,30,60].includes(value.archiveDays as number))) return json({ error: 'Invalid preferences' }, 400);
  try { quietNow(Date.now(), value.timezone, value.start as number, value.end as number); } catch { return json({ error: 'Invalid timezone' }, 400); }
  await env.DB.prepare(`UPDATE devices SET timezone=?,quiet_start=?,quiet_end=?,morning=?,evening=?,overdue=?,cold_days=?,archive_days=?,app_scheme=?
    WHERE id=?`).bind(value.timezone, value.start as number, value.end as number, (value.morning as number | undefined) ?? device.morning,
    (value.evening as number | undefined) ?? device.evening, value.overdue === undefined ? device.overdue : Number(value.overdue),
    (value.coldDays as number | undefined) ?? device.cold_days, (value.archiveDays as number | undefined) ?? device.archive_days,
    value.app === undefined ? device.app_scheme : appScheme(value.app), device.id).run();
  return json({ ok: true });
}
export async function handleRequest(request: Request, env: Environment): Promise<Response> {
  const url = new URL(request.url);
  if (url.protocol !== 'https:') return json({ error: 'HTTPS required' }, 400);
  if (url.pathname.startsWith('/open/') && request.method === 'GET') return openApp(url);
  if (!env.DB || !/^[a-zA-Z0-9_]{5,32}$/.test(env.FIXTURE_BOT_NAME ?? '') || !env.FIXTURE_WEBHOOK_KEY || !env.FIXTURE_PAIRING_PEPPER)
    return json({ error: 'Server not configured' }, 503);
  try {
    const route = `${request.method} ${url.pathname}`;
    if (route === 'GET /health') return json({ ok: !!await env.DB.prepare('SELECT morning FROM devices LIMIT 1').all() });
    if (route === 'POST /webhook') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.FIXTURE_WEBHOOK_KEY) return json({ error: 'Unauthorized' }, 401);
      return await processUpdate(env, await body(request) as Parameters<typeof processUpdate>[1]) ? json({ ok: true }) : json({ error: 'Invalid update' }, 400);
    }
    if (route === 'POST /v1/pair') return await pair(request, url, env);
    const token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const device = token ? await env.DB.prepare('SELECT * FROM devices WHERE token_hash=? AND revoked=0').bind(await digest(token)).first<Device>() : null;
    if (!device) return json({ error: 'Unauthorized' }, 401);
    if (!await allow(env, `device:${device.id}`, 60)) return json({ error: 'Try later' }, 429);
    if (route === 'GET /v1/device') return json(deviceStatus(device));
    if (route === 'POST /v1/device/pairing') return await decidePairing(request, env, device);
    if (route === 'DELETE /v1/device') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM remote_actions WHERE device_id=?').bind(device.id),
        env.DB.prepare('DELETE FROM remote_tasks WHERE device_id=?').bind(device.id),
        env.DB.prepare('DELETE FROM devices WHERE id=?').bind(device.id),
      ]);
      return json({ revoked: true });
    }
    if (!device.chat_id) return json({ error: 'Pair first' }, 409);
    if (route === 'POST /v1/tasks') return await upload(request, env, device);
    if (route === 'POST /v1/actions/ack') return await acknowledge(request, env, device);
    if (route === 'POST /v1/quiet-hours') return await preferences(request, env, device);
    if (route === 'POST /v1/test') {
      if (!await allow(env, `device:test:${device.id}`, 2)) return json({ error: 'Try later' }, 429);
      await telegram(env, 'sendMessage', { chat_id: device.chat_id, text: '🔔 Тест Auto CRM. Связь с Telegram работает.' });
      return json({ sent: true });
    }
    if (route === 'GET /v1/actions') {
      const cursor = Number(url.searchParams.get('after') ?? 0);
      if (!sequence(cursor)) return json({ error: 'Invalid cursor' }, 400);
      return json((await env.DB.prepare('SELECT seq,task_id,action,due_at,revision,value FROM remote_actions WHERE device_id=? AND seq>? AND outcome IS NULL ORDER BY seq LIMIT 100')
        .bind(device.id, cursor).all()).results);
    }
    return json({ error: 'Not found' }, 404);
  } catch (cause) {
    if (cause instanceof InputError) return json({ error: 'Invalid request' }, 400);
    if (request.method === 'POST' && url.pathname === '/webhook' && !(cause instanceof WebhookInProgress)) {
      logWebhookFailure(cause);
    }
    return json({ error: 'Request could not be completed' }, 503);
  }
}
export default { fetch: handleRequest, scheduled: (_controller: unknown, env: Environment, context: { waitUntil(work: Promise<void>): void }) => context.waitUntil(sendDue(env)) };
