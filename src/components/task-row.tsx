import { useNow } from './clock';
import { router } from 'expo-router';
import { Alert, Pressable, Text, View } from 'react-native';
import type { TaskSummary } from '../repositories/crm-repository';
import { useRepository } from '../storage/app-provider';
import { formatDate, useTheme } from '../theme';
import { reconcileReminders } from '../services/task-reminders';
import { Icon, IconButton } from './kit';
import { useRef, useState } from 'react';

export function TaskRow({ task, onChanged, highlighted = false }: { task: TaskSummary; onChanged: () => void; highlighted?: boolean }) {
  const { colors, ui } = useTheme();
  const repository = useRepository(), lock = useRef(false); const [busy, setBusy] = useState(false);
  const now = useNow();
  const overdue = task.status === 'pending' && task.due_at < now;
  async function complete() {
    if (lock.current) return; lock.current = true; setBusy(true);
    try { await repository.completeTask(task.id); onChanged(); void reconcileReminders(repository).catch(() => undefined); }
    catch (error) { Alert.alert('Задача', error instanceof Error ? error.message : 'Не удалось выполнить. Повторите попытку.'); }
    finally { lock.current = false; setBusy(false); }
  }
  return <View style={[ui.card, ui.row, { padding: 10, borderColor: highlighted ? colors.accent : colors.border }]}>
    <View style={ui.glyph}><Icon size={18} name={task.status === 'done' ? 'check' : /осмотр/i.test(task.title) ? 'car-outline' : /звон/i.test(task.title) ? 'phone-outline' : 'calendar-check-outline'} color={overdue ? colors.warning : colors.accent} /></View>
    <Pressable accessibilityRole="button" accessibilityLabel={`Открыть задачу ${task.title}`} style={{ flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center', gap: 2 }} onPress={() => router.navigate({ pathname: '/task/[id]', params: { id: task.id } })}>
      <Text style={[ui.body, { fontWeight: '600' }]}>{task.title}</Text>
      {task.important === 1 && task.status === 'pending' ? <Text style={[ui.muted, { color: colors.danger }]}>⚑ Важное</Text> : null}
      <Text style={[ui.muted, { fontSize: 12, lineHeight: 17 }]}>{task.vehicle_title}</Text><Text style={{ color: task.status === 'done' ? colors.muted : overdue ? colors.warning : colors.accent, fontSize: 12, lineHeight: 17 }}>{task.status === 'done' ? `Готово · ${formatDate(task.completed_at ?? task.due_at)}` : `${overdue ? 'Просрочено · ' : ''}${formatDate(task.due_at)}`}{task.status === 'pending' && task.repeat_mode !== 'none' ? task.repeat_mode === 'daily' ? ' · ежедневно' : ' · еженедельно' : ''}</Text>
    </Pressable>
    {task.status !== 'done' && task.vehicle_status !== 'completed' ? <IconButton name="checkbox-blank-outline" label="Выполнить задачу" disabled={busy} onPress={() => { void complete(); }} /> : task.status === 'done' ? null : <Text style={ui.muted}>Архив</Text>}
  </View>;
}
