import { useNow } from '../components/clock';
import { router } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActionButton } from '../components/action-button';
import { Chips, Empty, IconButton, LoadState, useLoad } from '../components/kit';
import { ConfirmDialog, SelectionToolbar } from '../components/confirm-dialog';
import { TaskRow } from '../components/task-row';
import { useRepository } from '../storage/app-provider';
import { useTheme } from '../theme';
import { reconcileReminders } from '../services/task-reminders';

export function TasksScreen() {
  const { colors, ui } = useTheme();
  const repository = useRepository(), insets = useSafeAreaInsets(), now = useNow();
  const load = useLoad(useCallback(() => repository.listTasks(), [repository]));
  const [filter, setFilter] = useState('all'), [selected, setSelected] = useState(() => new Date()), [calendar, setCalendar] = useState(false);
  const [manage, setManage] = useState(false), [selection, setSelection] = useState<string[] | null>(null), [confirm, setConfirm] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false), [removeError, setRemoveError] = useState(''), [message, setMessage] = useState('');
  const removing = useRef(false);
  async function remove() {
    if (!confirm || removing.current) return;
    removing.current = true; setDeleting(true); setRemoveError('');
    try {
      const count = await repository.deleteCompletedTasks(confirm);
      setConfirm(null); setSelection(null); setMessage(`Удалено выполненных задач: ${count}.`);
      void reconcileReminders(repository).catch(() => undefined);
      repository.notifyChanges();
      await load.refresh();
    } catch (cause) { setRemoveError(cause instanceof Error ? cause.message : 'Не удалось удалить задачи.'); }
    finally { removing.current = false; setDeleting(false); }
  }
  const start = new Date(selected); start.setHours(0, 0, 0, 0); const end = new Date(start); end.setDate(end.getDate() + 1);
  const today = new Date(now); today.setHours(0, 0, 0, 0); const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const items = load.data?.filter(task => filter === 'done' ? task.status === 'done' : task.status === 'pending' &&
    (filter === 'overdue' ? task.due_at < now : filter === 'today' ? task.due_at >= today.getTime() && task.due_at < tomorrow.getTime() : filter === 'future' ? task.due_at >= tomorrow.getTime() : filter === 'day' ? task.due_at >= start.getTime() && task.due_at < end.getTime() : true)) ?? [];
  return <View style={ui.screen}><FlatList style={ui.screen} data={items} keyExtractor={item => item.id} contentInsetAdjustmentBehavior="automatic"
    contentContainerStyle={[ui.listContent, { paddingLeft: 16 + insets.left, paddingRight: 16 + insets.right, flexGrow: 1 }]}
    ListHeaderComponent={<View style={{ gap: 8, marginBottom: 8 }}>
      <View style={[ui.row, { flexWrap: 'wrap', gap: 6 }]}><View style={{ flex: 1, minWidth: 120 }}><Text style={ui.heading}>План задач</Text><Text style={ui.muted}>{items.length} в выбранном списке</Text></View><IconButton name="calendar-month-outline" label="Открыть календарь" onPress={() => setCalendar(v => !v)} /><ActionButton label="Новая задача" compact onPress={() => router.push('/task/new')} /></View>
      {calendar ? <View style={ui.card}><View style={[ui.row, { justifyContent: 'space-between' }]}><IconButton name="chevron-left" label="Предыдущая неделя" onPress={() => { const day = new Date(selected); day.setDate(day.getDate() - 7); setSelected(day); }} /><Text style={ui.body}>{selected.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}</Text><IconButton name="chevron-right" label="Следующая неделя" onPress={() => { const day = new Date(selected); day.setDate(day.getDate() + 7); setSelected(day); }} /></View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>{Array.from({ length: 7 }, (_, index) => { const day = new Date(selected); day.setDate(selected.getDate() - ((selected.getDay() + 6) % 7) + index); const active = day.toDateString() === selected.toDateString(); return <Pressable key={index} accessibilityRole="button" accessibilityLabel={day.toLocaleDateString('ru-RU')} accessibilityState={{ selected: active }} onPress={() => { setSelected(day); setFilter('day'); }} style={{ minWidth: 44, flexGrow: 1, minHeight: 48, gap: 4, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: active ? colors.accent : colors.surface }}><Text style={{ fontSize: 10, color: active ? colors.onAccent : colors.muted }}>{day.toLocaleDateString('ru-RU', { weekday: 'short' })}</Text><Text style={{ color: active ? colors.onAccent : colors.text }}>{day.getDate()}</Text></Pressable>; })}</View>
      </View> : null}
      <View style={[ui.row, { gap: 3 }]}><View style={{ flex: 1, minWidth: 0 }}>
        <Chips value={filter} choices={[[ 'all', 'Все' ], [ 'overdue', 'Просрочено' ], [ 'today', 'Сегодня' ], [ 'future', 'Позже' ], [ 'done', 'Выполнено' ], ...(filter === 'day' ? [[ 'day', selected.toLocaleDateString('ru-RU') ] as const] : [])]} onChange={value => { setFilter(value); setSelection(null); setMessage(''); }} />
      </View>{filter === 'done' && items.length ? <IconButton name="dots-vertical" label="Управление выполненными задачами" onPress={() => setManage(true)} /> : null}</View>
      {selection ? <SelectionToolbar count={selection.length} onCancel={() => setSelection(null)} onRemove={() => { setRemoveError(''); setConfirm(selection); }} /> : null}
      {message ? <Text accessibilityLiveRegion="polite" style={ui.muted}>{message}</Text> : null}
      <LoadState loading={load.loading} error={load.error} retry={() => { void load.refresh(); }} />
    </View>}
    ListEmptyComponent={!load.loading && !load.error ? <Empty title="Задач в этом списке нет" body="Создайте следующее действие для автомобиля — оно появится здесь и в его карточке." icon="calendar-check-outline" /> : null}
    ItemSeparatorComponent={() => <View style={{ height: 9 }} />} renderItem={({ item }) => selection && filter === 'done'
      ? <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selection.includes(item.id) }} onPress={() => setSelection(previous => previous?.includes(item.id) ? previous.filter(id => id !== item.id) : [...previous ?? [], item.id])} style={[ui.card, ui.row]}>
        <Text style={[ui.heading, { color: colors.accent }]}>{selection.includes(item.id) ? '☑' : '☐'}</Text>
        <Text style={[ui.body, { flex: 1 }]}>{item.title}</Text>
      </Pressable>
      : <TaskRow task={item} onChanged={() => { void load.refresh(); }} />} />
    <ConfirmDialog title="Выполненные задачи" visible={manage} onClose={() => setManage(false)}>
      <ActionButton label="Выбрать задачи" secondary onPress={() => { setManage(false); setSelection([]); }} />
      <ActionButton label="Очистить выполненные" onPress={() => { setManage(false); setRemoveError(''); setConfirm(items.map(item => item.id)); }} />
    </ConfirmDialog>
    <ConfirmDialog title={`Удалить выполненные задачи (${confirm?.length ?? 0})?`} visible={!!confirm} onClose={() => setConfirm(null)} busy={deleting}>
      <Text style={ui.muted}>История автомобиля, активные задачи и следующие повторения сохранятся.</Text>
      {removeError ? <Text style={ui.error}>{removeError}</Text> : null}
      <ActionButton label={deleting ? 'Удаляем…' : 'Удалить задачи'} disabled={deleting} onPress={() => { void remove(); }} />
    </ConfirmDialog>
  </View>;
}
