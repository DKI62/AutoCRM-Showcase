import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import { deleteAsync, readAsStringAsync, writeAsStringAsync } from 'expo-file-system/legacy';
import { randomUUID } from 'expo-crypto';
import { Platform } from 'react-native';
import { diagnosticEvents, rotateDiagnostics, safeDiagnosticValues, type DiagnosticEvent, type DiagnosticValues } from './diagnostic-format';

const file = new File(Paths.document, 'beta-diagnostics.jsonl');
const session = randomUUID();
let queue = Promise.resolve();
let pending: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
const read = () => readAsStringAsync(file.uri).catch(() => '');
export function flushDiagnostics() {
  clearTimeout(timer);
  timer = undefined;
  const entries = pending;
  pending = [];
  if (entries.length) queue = queue.then(async () => {
    const prior = await read();
    await writeAsStringAsync(file.uri, rotateDiagnostics(prior, entries, Date.now()));
  }).catch(() => undefined);
  return queue;
}
export function diagnostic(event: DiagnosticEvent, values: DiagnosticValues = {}) {
  if (!diagnosticEvents.includes(event)) return;
  const now = new Date();
  pending.push(JSON.stringify({ utc: now.toISOString(), offset: -now.getTimezoneOffset(), session, event, ...safeDiagnosticValues(values) }));
  if (pending.length >= 48 || event === 'alarm.scheduled' || event === 'session.background' || event === 'js.error') void flushDiagnostics();
  else timer ??= setTimeout(() => { void flushDiagnostics(); }, 250);
}
export async function diagnosticLog() {
  await flushDiagnostics();
  return rotateDiagnostics(await read(), [], Date.now());
}
export async function clearDiagnostics() {
  await flushDiagnostics();
  const clear = queue.then(() => deleteAsync(file.uri, { idempotent: true }));
  queue = clear.catch(() => undefined);
  return clear;
}
export function diagnosticDevice() {
  const android = Platform.OS === 'android' ? Platform.constants : null;
  return `Auto CRM ${Constants.expoConfig?.version ?? '?'} / build ${Constants.platform?.android?.versionCode ?? '?'}\nAndroid ${android?.Release ?? '?'} (API ${Platform.Version}) · ${android?.Model ?? '?'}\n${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
}
let started = false;
export function startDiagnostics() {
  if (started) return;
  started = true;
  void read().then(previous => {
    const last = previous.split('\n').filter(line => line.includes('"event":"session.')).at(-1) ?? '';
    diagnostic('session.start', { unclean: Number(last.includes('session.active') || last.includes('session.start')) });
  });
  const errors = (globalThis as typeof globalThis & {
    ErrorUtils?: { getGlobalHandler(): (error: unknown, fatal?: boolean) => void; setGlobalHandler(handler: (error: unknown, fatal?: boolean) => void): void };
  }).ErrorUtils;
  const original = errors?.getGlobalHandler();
  if (original) errors?.setGlobalHandler((error, fatal) => {
    diagnostic('js.error', { fatal: Number(!!fatal) });
    original(error, fatal);
  });
}
