import type { Environment } from './worker';

export class TelegramFailure extends Error {
  constructor(readonly retryMs: number, readonly permanent: boolean, readonly code: number | null = null) { super('Telegram request failed'); }
}
export function logWebhookFailure(cause: unknown) {
  console.warn('Telegram webhook failed', cause instanceof TelegramFailure ? { telegramCode: cause.code } : { failure: 'processing' });
}
export async function telegram(env: Environment, method: string, body: Record<string, unknown>) {
  if (!env.telegramFixture) throw new TelegramFailure(60000, true);
  const response = await env.telegramFixture(`https://telegram.fixture.invalid/${method}`, {
    method: 'POST', signal: AbortSignal.timeout(5000), redirect: 'manual',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => { throw new TelegramFailure(60000, false); });
  // workerd supports manual redirects. Never follow a Location with the token in the URL.
  if (response.status >= 300 && response.status < 400) throw new TelegramFailure(60000, false, response.status);
  const result = await response.json().catch(() => null) as { ok?: boolean; result?: { message_id?: number }; error_code?: number; parameters?: { retry_after?: number } } | null;
  if (!response.ok || result?.ok !== true) {
    const code = typeof result?.error_code === 'number' ? result.error_code : response.ok ? null : response.status;
    const seconds = result?.parameters?.retry_after;
    throw new TelegramFailure(typeof seconds === 'number' && Number.isFinite(seconds) ? Math.max(1, Math.min(86400, seconds)) * 1000 : 60000,
      code === 400 || code === 403, code);
  }
  return result.result;
}

export const tokenId = () => crypto.randomUUID().replaceAll('-', '');
export async function allow(env: Environment, scope: string, limit: number, interval = 60000) {
  const window = Math.floor(Date.now() / interval);
  const result = await env.DB.prepare(`INSERT INTO bot_limits VALUES(?,?,1) ON CONFLICT(scope) DO UPDATE
    SET attempts=CASE WHEN window=excluded.window THEN attempts+1 ELSE 1 END,window=excluded.window
    WHERE window!=excluded.window OR attempts<?`).bind(scope, window, limit).run();
  return result.meta.changes === 1;
}
