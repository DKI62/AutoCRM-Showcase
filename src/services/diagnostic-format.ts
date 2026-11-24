export const diagnosticEvents = [
  'session.start', 'session.background', 'session.active', 'sqlite.open', 'sqlite.ready', 'sqlite.error',
  'task.write', 'sync.done', 'sync.error', 'sync.backoff', 'telegram.http', 'alarm.snapshot', 'alarm.missing', 'alarm.schedule',
  'alarm.scheduled', 'alarm.cancelled', 'alarm.error', 'alarm.received', 'alarm.opened', 'alarm.permission', 'js.error',
] as const;
export type DiagnosticEvent = typeof diagnosticEvents[number];
export const diagnosticKeys = ['due', 'native', 'local', 'count', 'duration', 'uploaded', 'conflicts', 'retry', 'allowed', 'exact', 'importance', 'fatal', 'unclean', 'operation'] as const;
const telegramRoutes = ['/v1/device', '/v1/device/pairing', '/v1/pair', '/v1/quiet-hours', '/v1/actions', '/v1/actions/ack', '/v1/tasks', '/v1/test'] as const;
const httpMethods = ['GET', 'POST', 'DELETE'] as const;
const httpStages = ['network', 'timeout', 'http', 'decode'] as const;
export type DiagnosticValues = Partial<Record<typeof diagnosticKeys[number], number>> & {
  route?: string; method?: string; stage?: typeof httpStages[number]; status?: number; timeoutMs?: number;
};
export function safeDiagnosticValues(values: DiagnosticValues) {
  const safe: Record<string, string | number | undefined> = Object.fromEntries(diagnosticKeys.flatMap(key => Number.isSafeInteger(values[key]) ? [[key, values[key]]] : []));
  const route = telegramRoutes.find(route => route === values.route);
  const method = httpMethods.find(method => method === values.method);
  if (route) safe.route = route;
  if (method) safe.method = method;
  if (values.stage && httpStages.includes(values.stage)) safe.stage = values.stage;
  const { status, timeoutMs } = values;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) safe.status = status;
  if (typeof timeoutMs === 'number' && Number.isSafeInteger(timeoutMs) && timeoutMs > 0) safe.timeoutMs = timeoutMs;
  return safe;
}
export function rotateDiagnostics(previous: string, entries: string[], now: number, limit = 256 * 1024) {
  const cutoff = new Date(now - 7 * 86400000).toISOString();
  const lines = [...previous.split('\n'), ...entries].filter(line => {
    try { const event = JSON.parse(line); return typeof event.utc === 'string' && event.utc >= cutoff && diagnosticEvents.includes(event.event); }
    catch { return false; }
  });
  let size = 0;
  let first = lines.length;
  while (first > 0 && size + lines[first - 1]!.length + 1 <= limit) size += lines[--first]!.length + 1;
  return lines.slice(first).join('\n');
}
