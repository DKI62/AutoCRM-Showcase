// Native I/O is injected so the asynchronous copy/commit boundary is testable without a device.
export interface MediaCopyIO {
  sourceSize: number;
  freeBytes: number;
  copy(): Promise<void>;
  copiedSize(): number;
  validate(): Promise<void>;
  commit(): Promise<void>;
  cleanup(): void;
}

export async function copyMediaSafely(io: MediaCopyIO): Promise<number> {
  if (io.sourceSize > 0 && io.freeBytes < io.sourceSize + 8 * 1024 * 1024)
    throw new Error('Недостаточно свободного места. Освободите память и повторите импорт.');
  try {
    await io.copy();
    const size = io.copiedSize();
    if (size < 1 || (io.sourceSize > 0 && size !== io.sourceSize))
      throw new Error('Файл скопирован не полностью. Исходник сохранён; повторите выбор.');
    await io.validate();
    await io.commit();
    return size;
  } catch (error) {
    try { io.cleanup(); } catch { /* Keep the original I/O failure; no saved file is removed. */ }
    throw error;
  }
}

export async function importBatch<T, R>(items: readonly T[], copy: (item: T) => Promise<R>, discard: (item: R) => void): Promise<R[]> {
  const staged: R[] = [];
  try {
    for (const item of items) staged.push(await copy(item));
    return staged;
  } catch (error) {
    for (const item of staged) { try { discard(item); } catch { /* Only this batch's new copies. */ } }
    throw error;
  }
}
