import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyMediaSafely, importBatch, type MediaCopyIO } from '../src/services/media-copy';
import { resolveMediaType } from '../src/services/image-rules';
import { updatePhotoLoad } from '../src/domain/photo-load';

test('fullscreen photo falls back after a decode error and ignores late callbacks', () => {
  const fallback = updatePhotoLoad('expo', 'expo', false);
  assert.equal(fallback, 'native');
  assert.equal(updatePhotoLoad(fallback, 'expo', true), fallback);
  assert.equal(updatePhotoLoad(fallback, 'native', false), 'failed');
  assert.equal(updatePhotoLoad(fallback, 'native', true), 'native-ready');
  assert.equal(updatePhotoLoad('native-ready', 'native', false), 'native-ready');
  assert.equal(updatePhotoLoad('expo', 'expo', true), 'expo-ready');
  assert.equal(updatePhotoLoad('expo-ready', 'expo', false), 'expo-ready');
});

test('copy is awaited before inspection and commit, including files larger than 25 MB', async () => {
  const order: string[] = [];
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const size = 800 * 1024 * 1024;
  const io: MediaCopyIO = { sourceSize: size, freeBytes: size * 2,
    copy: async () => { order.push('copy'); await wait; order.push('copied'); },
    copiedSize: () => { order.push('inspect'); return size; },
    validate: async () => { order.push('validate'); }, commit: async () => { order.push('commit'); }, cleanup: () => order.push('cleanup') };
  const result = copyMediaSafely(io);
  await Promise.resolve();
  assert.deepEqual(order, ['copy']); release();
  assert.equal(await result, size);
  assert.deepEqual(order, ['copy', 'copied', 'inspect', 'validate', 'commit']);
});

test('partial copy, decoder error and insufficient storage do not commit; batches compensate only new copies', async () => {
  let commits = 0; let cleanups = 0;
  const io: MediaCopyIO = { sourceSize: 10, freeBytes: 1e9, copy: async () => {}, copiedSize: () => 9,
    validate: async () => {}, commit: async () => { commits++; }, cleanup: () => { cleanups++; } };
  await assert.rejects(copyMediaSafely(io), /не полностью/);
  await assert.rejects(copyMediaSafely({ ...io, copiedSize: () => 10, validate: async () => { throw new Error('decode'); } }), /decode/);
  await assert.rejects(copyMediaSafely({ ...io, freeBytes: 0 }), /места/);
  assert.equal(commits, 0); assert.equal(cleanups, 2);
  const deleted: number[] = [];
  await assert.rejects(importBatch([1, 2, 3], async i => { if (i === 3) throw new Error('provider closed'); return i; }, i => deleted.push(i)));
  assert.deepEqual(deleted, [1, 2]);
});

test('picker MIME resolution supports PNG screenshots without MIME and videos without guessing JPEG', () => {
  assert.equal(resolveMediaType(null, 'Screenshot_2026.PNG'), 'image/png');
  assert.equal(resolveMediaType('application/octet-stream', 'inspection.mp4'), 'video/mp4');
  assert.equal(resolveMediaType(undefined, 'content://provider/42', 'image/jpeg'), 'image/jpeg');
  assert.equal(resolveMediaType('image/*', 'content://provider/42', 'image/png'), 'image/png');
  assert.throws(() => resolveMediaType(null, 'content://provider/42'));
});
