import { randomUUID } from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Switch, Text, ToastAndroid, View } from 'react-native';
import { ActionButton } from '../components/action-button';
import { Chips, Field, Icon, LoadState, Page, useLoad } from '../components/kit';
import { VehicleChooser } from '../components/vehicle-chooser';
import { ConfirmDialog } from '../components/confirm-dialog';
import { DeadlineFields } from '../components/deadline-fields';
import { useNow } from '../components/clock';
import { useDiscardDraft } from '../components/discard-draft';
import { vehicleName, type Task } from '../domain/models';
import { isNewPastDeadline, quickTaskDeadline } from '../domain/task-deadline';
import type { TaskSummary } from '../repositories/crm-repository';
import { createCommitGate } from '../services/commit-gate';
import { reconcileReminders } from '../services/task-reminders';
import { useRepository } from '../storage/app-provider';
import { formatDate, useTheme } from '../theme';

function TaskForm({ task, vehicleId = '', initialVehicleTitle = '' }: { task?: TaskSummary; vehicleId?: string; initialVehicleTitle?: string }) {
  const { colors, ui } = useTheme();
  const repository = useRepository();
  const now = useNow();
  const [vehicle, setVehicle] = useState(task?.vehicle_id ?? vehicleId);
  const [vehicleTitle, setVehicleTitle] = useState(task?.vehicle_title ?? initialVehicleTitle);
  const [initialTask] = useState(task);
  const [taskId] = useState(() => task?.id ?? randomUUID());
  const [gate] = useState(createCommitGate);
  const [title, setTitle] = useState(task?.title ?? ''), [description, setDescription] = useState(task?.description ?? '');
  const [expanded, setExpanded] = useState(!!task?.description);
  const [date, setDate] = useState(() => new Date(task?.due_at ?? Date.now() + 3600000));
  const [repeat, setRepeat] = useState<Task['repeat_mode']>(task?.repeat_mode ?? 'none');
  const [important, setImportant] = useState(task?.important === 1);
  const [removePrompt, setRemovePrompt] = useState(false);
  const [showPostpone, setShowPostpone] = useState(false);
  const [busy, setBusy] = useState(false), [outcome, setOutcome] = useState<'saved' | 'done' | 'deleted' | 'reopened' | null>(null), [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const navigated = useRef(false);
  const readOnly = task?.status === 'done' || task?.vehicle_status === 'completed';

  const discardDraftDialog = useDiscardDraft(!outcome && dirty, !outcome && busy, () => gate.phase() !== 'idle');

  // Navigate after the commit render has disabled usePreventRemove. Never await Android here.
  useEffect(() => {
    if (!outcome || navigated.current) return;
    navigated.current = true;
    ToastAndroid.show(outcome === 'reopened' ? 'Задача возвращена в активные' : outcome === 'deleted' ? 'Задача удалена' : outcome === 'done' ? 'Задача выполнена' : 'Задача сохранена', ToastAndroid.SHORT);
    if (router.canGoBack()) router.back(); else router.replace('/tasks');
  }, [outcome]);

  async function commit(kind: NonNullable<typeof outcome>) {
    if (gate.phase() !== 'idle' || outcome) return;
    if (kind === 'reopened' ? task?.status !== 'done' || task.vehicle_status === 'completed'
      : kind === 'deleted' ? task?.status !== 'done' : readOnly) return;
    if (kind === 'saved' && !title.trim()) { setError('Введите название действия.'); return; }
    if (kind === 'saved' && isNewPastDeadline(date, initialTask?.due_at, Date.now())) {
      setError('Выбранный срок уже прошёл. Укажите будущее время или нажмите «+2 мин».'); return;
    }
    setBusy(true); setError(null);
    try {
      const result = await gate.run(async () => {
        if (kind === 'deleted') await repository.deleteCompletedTasks([taskId]);
        else if (kind === 'reopened' && task) await repository.reopenTask(taskId, task.updated_at);
        else if (kind === 'done') await repository.completeTask(taskId);
        else await repository.saveTask({ vehicle_id: vehicle, title, description, due_at: date.getTime(), status: 'pending', repeat_mode: repeat, important: important ? 1 : 0 }, taskId, initialTask?.updated_at, !initialTask);
      }, () => reconcileReminders(repository));
      if (result) {
        setRemovePrompt(false); setDirty(false); setOutcome(kind);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить задачу. Повторите попытку.'); }
    finally { setBusy(false); }
  }

  return <Page avoidAndroidKeyboard footer={vehicle && !readOnly ? <>
    {error ? <Text accessibilityRole="alert" style={ui.error}>{error}</Text> : null}
    <ActionButton label={busy ? 'Сохраняем…' : task ? date.getTime() !== initialTask?.due_at ? 'Сохранить перенос' : 'Сохранить' : 'Создать задачу'} disabled={busy || !!outcome} onPress={() => { void commit('saved'); }} />
  </> : undefined}>
    {discardDraftDialog}
    {!vehicle ? <><Text style={ui.heading}>Выберите автомобиль</Text><VehicleChooser onChoose={car => { setVehicle(car.id); setVehicleTitle(vehicleName(car)); }} /></> : <>
      <View style={[ui.row, { alignItems: 'flex-start' }]}><Icon name="car-outline" size={18} /><View style={{ flex: 1 }}>
        <Text style={ui.heading}>{vehicleTitle || 'Автомобиль'}</Text>
        <Text style={ui.muted}>{readOnly ? task?.status === 'done' ? 'Выполнено' : 'Автомобиль в архиве' : task ? 'Редактирование задачи' : 'Новое действие'}</Text>
      </View></View>
      {readOnly ? <Text style={ui.muted}>Срок · {formatDate(date.getTime())}</Text> : <>
        <DeadlineFields value={date} disabled={busy} onError={setError} onChange={value => {
          setDate(value); if (value.getTime() !== date.getTime()) setDirty(true); setError(null);
        }} />
        {task && !readOnly ? <ActionButton label={showPostpone ? 'Скрыть быстрый перенос' : 'Быстрый перенос'} secondary compact disabled={busy} onPress={() => setShowPostpone(value => !value)} /> : null}
        {showPostpone && !readOnly ? <Chips value={undefined} choices={[[ '30m', '+30 мин' ], [ '1h', '+1 час' ], [ 'tomorrow', 'Завтра' ]]} onChange={action => {
          if (busy) return;
          setDate(quickTaskDeadline(Date.now(), action)); setDirty(true); setError(null); setShowPostpone(false);
        }} /> : null}
      </>}
      {!readOnly ? <>
        <Field label="Что сделать?" value={title} onChangeText={value => { setTitle(value); setDirty(true); }} maxLength={200} editable={!busy} multiline style={{ minHeight: 48 }} placeholder="Например, позвонить продавцу" />
        {expanded ? <Field label="Описание · необязательно" value={description} multiline maxLength={2000} editable={!busy} onChangeText={value => { setDescription(value); setDirty(true); }} /> :
          <ActionButton label="Добавить описание" secondary compact disabled={busy} onPress={() => setExpanded(true)} />}
        <View><Text style={ui.label}>Повтор после выполнения</Text><Chips value={repeat} choices={[[ 'none', 'Один раз' ], [ 'daily', 'Ежедневно' ], [ 'weekly', 'Еженедельно' ]]}
          onChange={value => { if (!busy) { setRepeat(value); setDirty(true); } }} /></View>
        <View style={[ui.card, ui.row]}><Icon name="flag-outline" color={colors.danger} /><Text style={[ui.body, { flex: 1 }]}>Важное</Text><Switch accessibilityLabel="Важная задача" value={important} disabled={busy} trackColor={{ false: colors.controlBorder, true: colors.primary }} onValueChange={value => { setImportant(value); setDirty(true); }} /></View>
        {task ? <ActionButton label="Выполнить задачу" secondary compact disabled={busy || dirty || !!outcome} onPress={() => { void commit('done'); }} /> :
          <Text style={ui.muted}>Напоминание отправится, если уведомления разрешены в настройках.</Text>}
      </> : <><Text style={ui.title}>{title}</Text>{description ? <Text style={ui.body}>{description}</Text> : null}</>}
      {task?.status === 'done' && task.vehicle_status !== 'completed' ? <View style={ui.card}>
        <ActionButton label="Вернуть в активные" secondary disabled={busy || !!outcome} onPress={() => { void commit('reopened'); }} />
        <Text style={ui.muted}>{task.due_at <= now ? 'Срок уже прошёл. Задача вернётся как просроченная.' : 'Задача вернётся с прежним сроком.'}</Text>
        {task.repeat_mode !== 'none' ? <Text style={ui.muted}>Эта задача вернётся как разовая. Следующее повторение сохранится.</Text> : null}
        {!removePrompt && error ? <Text accessibilityRole="alert" style={ui.error}>{error}</Text> : null}
      </View> : null}
      {task ? <View style={[ui.row, { flexWrap: 'wrap' }]}>
        <ActionButton label="К автомобилю" secondary compact disabled={busy} onPress={() => router.navigate({ pathname: '/vehicle/[id]', params: { id: task.vehicle_id } })} />
        {task.status === 'done' ? <ActionButton label="Удалить задачу" secondary compact disabled={busy} onPress={() => { setError(null); setRemovePrompt(true); }} /> : null}
      </View> : null}
      <ConfirmDialog title="Удалить выполненную задачу?" visible={removePrompt} busy={busy} onClose={() => setRemovePrompt(false)}>
        <Text style={ui.muted}>История автомобиля и будущие повторения сохранятся.</Text>
        {error ? <Text style={ui.error}>{error}</Text> : null}
        <ActionButton label="Удалить задачу" disabled={busy} onPress={() => { void commit('deleted'); }} />
      </ConfirmDialog>
    </>}
  </Page>;
}

export function TaskScreen() {
  const { ui } = useTheme();
  const { id, vehicleId } = useLocalSearchParams<{ id?: string; vehicleId?: string }>();
  const repository = useRepository();
  const load = useLoad(useCallback(async () => ({
    task: id ? await repository.getTask(id) : null,
    vehicleTitle: !id && vehicleId ? await repository.getVehicle(vehicleId).then(value => value ? vehicleName(value.vehicle) : '') : '',
  }), [repository, id, vehicleId]));
  if (!load.data) return <Page><LoadState loading={load.loading} error={load.error} retry={() => { void load.refresh(); }} /></Page>;
  if (!id) return <TaskForm vehicleId={vehicleId ?? ''} initialVehicleTitle={load.data.vehicleTitle} />;
  return load.data.task ? <TaskForm key={id} task={load.data.task} /> : <Page><Text style={ui.heading}>Задача не найдена</Text><ActionButton label="Все задачи" onPress={() => router.replace('/tasks')} /></Page>;
}
