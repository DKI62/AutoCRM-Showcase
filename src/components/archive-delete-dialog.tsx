import { useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { vehicleName } from '../domain/models';
import { finishMediaCleanup, imageFile } from '../services/image-files';
import { reconcileReminders } from '../services/task-reminders';
import { useRepository } from '../storage/app-provider';
import { useTheme } from '../theme';
import { ActionButton } from './action-button';
import { ConfirmDialog } from './confirm-dialog';

type Preview = { title: string; photos: number; videos: number; notes: number; tasks: number; bytes: number };

export function ArchiveDeleteDialog({ ids, onClose, onDone }: { ids: string[]; onClose: () => void; onDone: (message: string) => void }) {
  const { ui } = useTheme();
  const repository = useRepository();
  const [preview, setPreview] = useState<Preview[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    let active = true;
    void Promise.all(ids.map(async id => {
      const detail = await repository.getVehicle(id);
      if (!detail || detail.vehicle.status !== 'completed') throw new Error('Карточка больше не находится в архиве.');
      const tasks = await repository.listTasks(id);
      let bytes = 0;
      for (const item of detail.attachments) {
        try { const file = imageFile(item.relative_path); if (file.exists) bytes += file.size; } catch { /* Unknown files contribute no estimate. */ }
      }
      const photos = detail.attachments.filter(item => item.mime_type.startsWith('image/')).length;
      return { title: vehicleName(detail.vehicle), photos, videos: detail.attachments.length - photos, notes: detail.notes.length, tasks: tasks.length, bytes };
    })).then(data => { if (active) setPreview(data); }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Не удалось прочитать карточки.'); });
    return () => { active = false; };
  }, [ids, repository]);
  async function remove() {
    if (!preview || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await repository.deleteArchivedVehicles(ids);
      void reconcileReminders(repository).catch(() => undefined);
      const pending = await finishMediaCleanup(repository).catch(() => -1);
      const queued = pending !== 0 || (await repository.cleanupFiles().catch(() => [null])).length > 0;
      onDone(`Удалено карточек: ${result.vehicles}.${queued ? ' Удаление части файлов ещё в очереди.' : ''}`);
      repository.notifyChanges();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Удаление не удалось.');
      lock.current = false;
      setBusy(false);
    }
  }
  return <ConfirmDialog visible title={ids.length === 1 ? 'Удалить автомобиль из CRM?' : `Удалить из CRM выбранные карточки (${ids.length})?`} onClose={onClose} busy={busy}>
    <Text style={ui.muted}>Карточки, история, задачи и файлы CRM будут удалены. Для восстановления потребуется резервная копия.</Text>
    <Text style={ui.muted}>Оригиналы останутся в галерее телефона. CRM хранит собственные копии и не может надёжно определить исходные файлы.</Text>
    {preview?.map((item, index) => <Text key={ids[index]} style={ui.body}>{item.title} · фото {item.photos}, видео {item.videos}, задачи {item.tasks}, заметки {item.notes}{item.bytes ? ` · ≈ ${(item.bytes / 1048576).toFixed(1)} МБ` : ''}</Text>)}
    {!preview && !error ? <Text style={ui.muted}>Проверяем содержимое карточек…</Text> : null}
    {error ? <Text accessibilityRole="alert" style={ui.error}>{error}</Text> : null}
    <ActionButton label={busy ? 'Удаляем…' : 'Удалить из CRM'} disabled={busy || !preview} onPress={() => { void remove(); }} />
  </ConfirmDialog>;
}
