import { nativePercentageErrors } from './native-ui-guard';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import type { ConfigContext, ExpoConfig } from 'expo/config';
import appConfig from '../app.config';
import { palettes, resolveAppearance } from '../src/domain/appearance';
import { isWebUrl, nextRepeatDate, validateVehicle } from '../src/domain/models';
import { isNewPastDeadline, mergeTaskDeadline, quickTaskDeadline, taskDeadlineOnDay } from '../src/domain/task-deadline';
import { displayRubles, formatRubles, rubleDigits } from '../src/domain/money';
import { focusedFieldScroll, keyboardOverlap } from '../src/domain/form-viewport';
import { coverAspectRatio, vehicleRowLayout } from '../src/domain/vehicle-photo-layout';
import { assertBackupMetadataSize, assertCompleteBackup } from '../src/services/backup-manifest';
import { rotateDiagnostics, safeDiagnosticValues } from '../src/services/diagnostic-format';
import { assertLocalImageUri, assertManagedPath, imageExtension } from '../src/services/image-rules';
import { drainShareInbox, parseShare } from '../src/services/share-input';
import { sanitizeSystemPath } from '../src/services/system-path';
import { telegramHttp } from '../src/services/telegram-http';
import { vehicleLink } from '../src/domain/vehicle-links';

test('system appearance tracks both Android schemes and explicit choices override them', () => {
  assert.equal(resolveAppearance('system', 'light'), 'light');
  assert.equal(resolveAppearance('system', 'dark'), 'dark');
  assert.equal(resolveAppearance('system', 'light'), 'light');
  assert.equal(resolveAppearance('system', 'unspecified'), 'dark');
  assert.equal(resolveAppearance('light', 'dark'), 'light');
  assert.equal(resolveAppearance('dark', 'light'), 'dark');
});

test('appearance palettes keep text, controls and selected states readable', () => {
  function luminance(hex: string) {
    const channel = (offset: number) => {
      const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  }
  function contrast(foreground: string, background: string) {
    const a = luminance(foreground), b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }
  for (const [scheme, colors] of Object.entries(palettes)) {
    for (const foreground of [colors.text, colors.muted, colors.accent, colors.success, colors.warning, colors.danger]) {
      for (const background of [colors.background, colors.surface, colors.raised, colors.primarySoft]) {
        assert.ok(contrast(foreground, background) >= 4.5, `${scheme} ${foreground} on ${background}`);
      }
    }
    assert.ok(contrast(colors.onPrimary, colors.primary) >= 4.5);
    assert.ok(contrast(colors.onPrimary, colors.primaryPressed) >= 4.5);
    assert.ok(contrast(colors.onAccent, colors.accent) >= 4.5);
  }
  assert.ok(contrast(palettes.light.controlBorder, palettes.light.surface) >= 3);
});

test('ruble input preserves exact whole units, grouping on paste, and legacy text', () => {
  assert.equal(formatRubles('1950'), '1\u202f950\u00a0₽');
  assert.equal(formatRubles('1950000'), '1\u202f950\u202f000\u00a0₽');
  assert.equal(formatRubles('9 999 999 999 999 999 999 ₽'), '9\u202f999\u202f999\u202f999\u202f999\u202f999\u202f999\u00a0₽');
  assert.equal(formatRubles('0'), '0\u00a0₽');
  assert.equal(formatRubles(''), '');
  assert.equal(formatRubles('до 50 000'), 'до 50 000');
  assert.equal(rubleDigits('19 50'), null);
  assert.equal(rubleDigits('1.950'), null);
  assert.equal(displayRubles('1.950'), '1.950 · уточнить сумму');
  assert.equal(rubleDigits(formatRubles('1950000')), '1950000');
});

test('form scroll reveals the whole field above the sticky footer and preserves a visible position', () => {
  assert.equal(focusedFieldScroll(250, 100, 300, 365, 44), 271);
  assert.equal(focusedFieldScroll(250, 100, 300, 145, 44), 250);
  assert.equal(focusedFieldScroll(250, 100, 300, 90, 76), 228);
  assert.equal(focusedFieldScroll(10, 100, 150, 210, 160), 108);
  assert.equal(focusedFieldScroll(0, 100, 150, 90, 44), 0);
});

test('only the IME overlap left after Android resize reduces the form viewport', () => {
  const keyboardTop = 516;
  assert.equal(keyboardOverlap(72, 444, keyboardTop), 0);
  assert.equal(keyboardOverlap(72, 480, keyboardTop), 36);
  const overlap = keyboardOverlap(72, 720, keyboardTop);
  assert.equal(overlap, 276);
  const viewport = 720 - overlap - 60;
  const next = focusedFieldScroll(420, 420, viewport, 780, 100);
  assert.equal(next, 508);
  assert.equal(focusedFieldScroll(next, next, viewport, 780, 100), next);
});

test('larger car photos leave a readable text column or stack at a narrow width or large font', () => {
  assert.deepEqual(vehicleRowLayout(328, 1, true), { thumbnailWidth: 116, stacked: false });
  assert.deepEqual(vehicleRowLayout(288, 1, true), { thumbnailWidth: 110, stacked: true });
  assert.deepEqual(vehicleRowLayout(380, 1.5, true), { thumbnailWidth: 116, stacked: true });
  assert.deepEqual(vehicleRowLayout(380, 1.5, false), { thumbnailWidth: 116, stacked: false });
  assert.ok(coverAspectRatio(9 / 20) < coverAspectRatio(16 / 9));
  assert.equal(coverAspectRatio(16 / 9), 16 / 9);
});

test('quick reminder changes keep local wall time across months and validate only new past deadlines', () => {
  const now = new Date(2026, 11, 31, 23, 59, 20).getTime();
  const old = new Date(2026, 11, 31, 18, 45);
  assert.strictEqual(taskDeadlineOnDay(old, now, 0), old);
  assert.equal(taskDeadlineOnDay(old, now, 3).getTime(), new Date(2027, 0, 3, 18, 45).getTime());
  assert.equal(quickTaskDeadline(now, '2m').getTime(), new Date(2027, 0, 1, 0, 2).getTime());
  assert.equal(isNewPastDeadline(old, old.getTime(), now), false);
  assert.equal(isNewPastDeadline(old, undefined, now), true);
  assert.equal(isNewPastDeadline(quickTaskDeadline(now, '2m'), undefined, now), false);
});

test('vehicle link rows preserve complete URLs and only label verified domains', () => {
  const path = 'https://www.avito.ru/auto/' + 'long-'.repeat(160) + '?code=a%2Fb';
  assert.deepEqual(vehicleLink(path), { href: path, label: 'Авито', hint: 'Открыть объявление' });
  assert.deepEqual(vehicleLink('autoteka.ru/report/42'), { href: 'https://autoteka.ru/report/42', label: 'Автотека', hint: 'Открыть отчёт' });
  assert.equal(vehicleLink('http://avito.ru.example.com/listing')?.label, 'Ссылка');
  for (const value of ['', 'javascript:alert(1)', 'intent://other', '//example.com', 'https://avito.ru@elsewhere.com', 'https://a.com/b c', 'https://']) {
    assert.equal(vehicleLink(value), null);
  }
});

test('Showcase launcher icons are configured and have a square 1024px canvas', () => {
  const { expo } = JSON.parse(readFileSync('app.json', 'utf8')) as { expo: ExpoConfig };
  assert.equal(expo.icon, './assets/autocrm-icon.png');
  assert.equal(expo.android?.adaptiveIcon?.foregroundImage, './assets/autocrm-adaptive.png');
  for (const file of [expo.icon, expo.android.adaptiveIcon.foregroundImage]) {
    const data = readFileSync(file);
    assert.equal(data.subarray(12, 16).toString(), 'IHDR');
    assert.deepEqual([data.readUInt32BE(16), data.readUInt32BE(20)], [1024, 1024]);
  }
});

test('date and time edits preserve the other component across midnight, month end, DST and zone changes', () => {
  const originalZone = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const previous = new Date(2026, 0, 31, 23, 58, 31, 7);
    const tomorrow = mergeTaskDeadline(previous, new Date(2026, 1, 1), 'date');
    assert.equal(tomorrow.getTime(), new Date(2026, 1, 1, 23, 58).getTime());
    const midnight = mergeTaskDeadline(tomorrow, new Date(2026, 0, 1, 0, 0), 'time');
    assert.equal(midnight.getTime(), new Date(2026, 1, 1, 0, 0).getTime());
    assert.strictEqual(mergeTaskDeadline(previous, new Date(2026, 0, 31), 'date'), previous);
    const gap = new Date(2026, 2, 7, 2, 30);
    assert.throws(() => mergeTaskDeadline(gap, new Date(2026, 2, 8), 'date'), /местного времени/);
    assert.equal(nextRepeatDate(gap.getTime(), 'daily', new Date(2026, 2, 8, 15).getTime()), new Date(2026, 2, 9, 2, 30).getTime());
    const beforeOverlap = new Date('2026-11-01T01:30:47-05:00');
    assert.strictEqual(mergeTaskDeadline(beforeOverlap, new Date(2026, 10, 1), 'date'), beforeOverlap);
    assert.equal(quickTaskDeadline(previous.getTime(), '30m').getTime(), new Date(2026, 1, 1, 0, 29).getTime());
    const beforeSpring = new Date(2026, 2, 7, 20, 12);
    assert.equal(quickTaskDeadline(beforeSpring.getTime(), 'tomorrow').getTime(), new Date(2026, 2, 8, 20, 12).getTime());
    const stored = midnight.getTime();
    process.env.TZ = 'Europe/Moscow';
    assert.equal(new Date(stored).getHours(), 8);
    assert.equal(midnight.getTime(), stored);
  } finally { if (originalZone === undefined) delete process.env.TZ; else process.env.TZ = originalZone; }
});

test('restore refuses a marked partial backup even when a manifest already exists', () => {
  assert.throws(() => assertCompleteBackup(['media', 'manifest.json', 'INCOMPLETE.txt']), /не завершена/);
  assert.throws(() => assertCompleteBackup(['media']), /manifest.json/);
  assert.doesNotThrow(() => assertCompleteBackup(['media', 'manifest.json']));
  assert.doesNotThrow(() => assertBackupMetadataSize(64 * 1024 * 1024));
  assert.throws(() => assertBackupMetadataSize(64 * 1024 * 1024 + 1), /64 МБ/);
});

test('a single redirect drains both share deliveries exactly once', async () => {
  const inbox = new Map([['older', Promise.resolve('first')], ['latest', Promise.resolve('second')]]);
  assert.deepEqual(await Promise.all(drainShareInbox(inbox)), ['first', 'second']);
  assert.deepEqual(drainShareInbox(inbox), []);
});

test('native percentage guard rejects the startup crash and accepts RN percentages and Compose fillMaxWidth', () => {
  const scan = (text: string) => nativePercentageErrors(ts.createSourceFile('fixture.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  assert.equal(scan(`import { Button } from '@expo/ui'; const view = <Button style={{width:'100%'}} />;`).length, 1);
  assert.equal(scan(`import { width as nativeWidth } from '@expo/ui/jetpack-compose/modifiers'; nativeWidth('100%');`).length, 1);
  assert.deepEqual(scan(`import { Pressable } from 'react-native'; const view = <Pressable style={{width:'100%'}} />;`), []);
  assert.deepEqual(scan(`import { Button } from '@expo/ui'; const view = <Button modifiers={[fillMaxWidth()]} />;`), []);
});

test('all source screens keep percentage dimensions out of native Compose controls', () => {
  for (const entry of readdirSync('src', { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, path.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    assert.deepEqual(nativePercentageErrors(source), [], path);
  }
});

test('vehicle validation rejects blank names, excessive data and unsafe source links', () => {
  assert.throws(() => validateVehicle({ make: ' ', model: 'B', note: '' }));
  assert.throws(() => validateVehicle({ make: 'A', model: 'B', note: 'x'.repeat(10001) }));
  assert.throws(() => validateVehicle({ make: 'A', model: 'B', note: '', sourceUrl: 'javascript:alert(1)' }));
  assert.equal(validateVehicle({ make: ' A ', model: ' B ', note: ' 450 если коробка живая ' }).note, '450 если коробка живая');
  assert.equal(isWebUrl('https://example.org/car'), true);
  assert.equal(isWebUrl('file:///private'), false);
});

test('native paths reject malformed percent encodings and excessive input before Router decoding', () => {
  assert.equal(sanitizeSystemPath('autocrm-showcase://expo-sharing'), 'autocrm-showcase://expo-sharing');
  assert.equal(sanitizeSystemPath('/add?title=%D0%90'), '/add?title=%D0%90');
  assert.equal(sanitizeSystemPath('/add?bad=%E0%A4%A'), '/');
  assert.equal(sanitizeSystemPath('x'.repeat(4097)), '/');
});

test('share parser accepts multiple local images/videos and URLs offline; rejects untrusted data', () => {
  const result = parseShare([
    { shareType: 'image', value: 'content://gallery/1', mimeType: 'image/png' },
    { shareType: 'text', value: 'https://example.org/car', mimeType: 'text/plain' },
  ]);
  assert.equal(result.image?.uri, 'content://gallery/1');
  assert.equal(result.sourceUrl, 'https://example.org/car');
  assert.equal(result.note, result.sourceUrl);
  assert.equal(parseShare([{ shareType: 'file', value: 'content://gallery/opaque', mimeType: 'image/*' }]).images[0]?.mime, 'image/*');
  assert.equal(parseShare([
    { shareType: 'image', value: 'content://gallery/1', mimeType: 'image/png' },
    { shareType: 'image', value: 'content://gallery/2', mimeType: 'image/png' },
    { shareType: 'video', value: 'content://gallery/3', mimeType: 'video/mp4' },
  ]).images.length, 3);
  assert.throws(() => parseShare([{ shareType: 'image', value: 'https://example.org/image', mimeType: 'image/png' }]));
  assert.throws(() => parseShare([{ shareType: 'file', value: 'content://gallery/1', mimeType: 'application/pdf' }]));
  assert.throws(() => parseShare([{ shareType: 'text', value: 'x'.repeat(10001) }]));
  assert.throws(() => parseShare([]));
});

test('image boundaries reject remote URIs, unsupported MIME types and paths outside managed files', () => {
  assertLocalImageUri('content://media/external/images/1');
  assertLocalImageUri('file:///data/local/picture.png');
  assert.throws(() => assertLocalImageUri('https://example.org/picture.png'));
  assert.throws(() => imageExtension('application/pdf'));
  assert.equal(imageExtension('image/png'), 'png');
  assertManagedPath('12345678-1234-1234-1234-123456789abc.png');
  for (const path of ['../picture.png', 'file:///data/secret', '..\\secret.jpg', '', 'picture.png'])
    assert.throws(() => assertManagedPath(path));
});

test('Showcase variants have separate packages and schemes with no OTA linkage', () => {
  const base = (JSON.parse(readFileSync('app.json', 'utf8')) as { expo: ExpoConfig }).expo;
  const previous = process.env.APP_VARIANT;
  try {
    process.env.APP_VARIANT = 'preview'; const preview = appConfig({ config: base } as ConfigContext);
    process.env.APP_VARIANT = 'development'; const development = appConfig({ config: base } as ConfigContext);
    assert.equal(preview.android?.package, 'com.autocrm.showcase');
    assert.equal(preview.android?.versionCode, 1);
    assert.notEqual(development.android?.package, preview.android?.package);
    assert.notEqual(development.scheme, preview.scheme);
    assert.equal(preview.updates?.enabled, false);
    assert.equal(preview.updates?.url, undefined);
    assert.equal(preview.owner, undefined);
    assert.equal(preview.extra?.eas, undefined);
    assert.equal(development.android?.package, 'com.autocrm.showcase.dev');
    assert.ok(!preview.android?.blockedPermissions?.includes('android.permission.CAMERA'));
    const sharing = base.plugins?.find(plugin => Array.isArray(plugin) && plugin[0] === 'expo-sharing');
    assert.ok(Array.isArray(sharing));
    assert.ok((sharing[1] as { android: { multipleShareMimeTypes: string[] } }).android.multipleShareMimeTypes.includes('image/*'));
  } finally { if (previous === undefined) delete process.env.APP_VARIANT; else process.env.APP_VARIANT = previous; }
});

test('diagnostics only accept allowlisted values and retain recent records within the byte budget', () => {
  const input = { count: 2, due: NaN, duration: Infinity, token: 'fixture-secret', note: 'fixture-note' };
  assert.deepEqual(safeDiagnosticValues(input), { count: 2 });
  assert.deepEqual(safeDiagnosticValues({ route: '/v1/actions?secret=fixture', method: 'fixture-secret', status: 0 }), {});
  const now = Date.UTC(2026, 10, 13);
  const row = (days: number, event: string) => JSON.stringify({ utc: new Date(now - days * 86400000).toISOString(), event });
  const latest = row(0, 'alarm.scheduled');
  const previous = [row(8, 'alarm.snapshot'), 'broken', row(1, 'unapproved.event'), row(1, 'alarm.snapshot')].join('\n');
  assert.equal(rotateDiagnostics(previous, [latest], now, latest.length + 1), latest);
  assert.equal(rotateDiagnostics(previous, [latest], now), `${row(1, 'alarm.snapshot')}\n${latest}`);
});

test('Telegram HTTP failures expose the stage without recording credentials, cursor, or response data', async () => {
  const events: ReturnType<typeof safeDiagnosticValues>[] = [];
  const record = (event: Parameters<typeof safeDiagnosticValues>[0]) => events.push(safeDiagnosticValues(event));
  const origin = 'https://fixture.invalid', token = 'fixture-token', route = '/v1/actions?after=999';
  const down = telegramHttp(async () => { throw new Error(token); }, record);
  const limited = telegramHttp(async () => Response.json({ token }, { status: 429 }), record);
  const malformed = telegramHttp(async () => new Response(token), record);
  await assert.rejects(down(origin, route, token), /Сервер Telegram недоступен/);
  await assert.rejects(limited(origin, route, token), /429/);
  await assert.rejects(malformed(origin, route, token), /Сервер Telegram недоступен/);
  assert.deepEqual(events.map(({ duration, ...event }) => {
    assert.ok(typeof duration === 'number' && duration >= 0);
    return event;
  }), [
    { route: '/v1/actions', method: 'GET', stage: 'network', timeoutMs: 12000 },
    { route: '/v1/actions', method: 'GET', stage: 'http', status: 429, timeoutMs: 12000 },
    { route: '/v1/actions', method: 'GET', stage: 'decode', status: 200, timeoutMs: 12000 },
  ]);
  const unauthorized = telegramHttp(async () => new Response(null, { status: 401 }), record);
  await assert.rejects(unauthorized(origin, '/v1/device', token), /Ключ устройства отозван/);
  assert.deepEqual(await unauthorized(origin, '/v1/device', token, undefined, 'DELETE'), { revoked: true });
  assert.equal(events.length, 4);
});

test('Telegram HTTP timeout aborts the request and reports a timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let stage: string | undefined;
  const request = telegramHttp((_url, options) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new Error('abort')));
  }), event => { stage = event.stage; });
  const error = assert.rejects(request('https://fixture.invalid', '/v1/device'), /Сервер Telegram недоступен/);
  t.mock.timers.tick(12000);
  await error;
  assert.equal(stage, 'timeout');
});
