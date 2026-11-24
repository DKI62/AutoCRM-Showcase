import type { DiagnosticValues } from './diagnostic-format';

const timeoutMs = 12000;
const unavailable = 'Сервер Telegram недоступен. Локальные данные и задачи сохранены.';

type Transport = (url: string, options: RequestInit) => Promise<Pick<Response, 'status' | 'ok' | 'json'>>;

export function telegramHttp(fetch: Transport, report: (values: DiagnosticValues) => void) {
  return async (origin: string, path: string, token?: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<unknown> => {
    const started = performance.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let status: number | undefined;
    function failed(stage: NonNullable<DiagnosticValues['stage']>) {
      report({ route: path.split('?', 1)[0] ?? '', method, stage, ...(status === undefined ? {} : { status }),
        timeoutMs, duration: Math.round(performance.now() - started) });
    }
    try {
      let response;
      try {
        response = await fetch(`${origin}${path}`, {
          method, signal: abort.signal, redirect: 'error',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        failed(abort.signal.aborted ? 'timeout' : 'network');
        throw new Error(unavailable);
      }
      status = response.status;
      if (status === 401 && method === 'DELETE') return { revoked: true };
      if (!response.ok) {
        failed('http');
        throw new Error(status === 401 ? 'Ключ устройства отозван. Подключите Telegram повторно.' : `Сервер Telegram вернул ошибку ${status}. Повторите позже.`);
      }
      try {
        return await response.json();
      } catch {
        failed(abort.signal.aborted ? 'timeout' : 'decode');
        throw new Error(unavailable);
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
