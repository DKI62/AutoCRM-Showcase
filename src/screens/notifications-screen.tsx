import { router } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useCallback } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { useNow } from '../components/clock';
import { Empty, LoadState, useLoad } from '../components/kit';
import { ActionButton } from '../components/action-button';
import { useRepository } from '../storage/app-provider';
import { formatDate, useTheme } from '../theme';
import { nativeTriggerTime } from '../services/notification-service';
import { reconcileReminders } from '../services/task-reminders';

const labels: Record<string, string> = { scheduled: 'Запланировано', received: 'Получено приложением', opened: 'Открыто', cancelled: 'Отменено' };
export function NotificationsScreen() {
  const { colors, ui } = useTheme();
  const repository = useRepository(), now = useNow();
  const load = useLoad(useCallback(async () => {
    const native = await Notifications.getAllScheduledNotificationsAsync().catch(() => null);
    return { entries: await repository.notificationLog(), reminders: await repository.pendingReminders(), cancellations: await repository.cancellations(),
      reviews: await repository.reviews(now), native: native ? new Map(native.map(item => [item.identifier, nativeTriggerTime(item.trigger)])) : null };
  }, [repository, now]));
  return <FlatList style={ui.screen} data={load.data?.entries ?? []} keyExtractor={item => item.id} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={ui.listContent}
    ListHeaderComponent={<View style={{ gap: 8, marginBottom: 8 }}><Text style={ui.heading}>Журнал напоминаний</Text><Text style={ui.muted}>Здесь события Android, а не отметки выполнения задач. Закрытие уведомления не завершает задачу. Android может задержать сигнал при экономии заряда.</Text>
      <LoadState loading={load.loading} error={load.error} retry={() => { void load.refresh(); }} />
      {!!load.data?.cancellations.length ? <Text style={ui.muted}>Отмены в очереди: {load.data.cancellations.length}. Приложение повторит попытку.</Text> : null}
      {load.data ? <ActionButton label="Сверить с Android" secondary compact onPress={() => {
        void reconcileReminders(repository).finally(load.refresh).catch(() => undefined);
      }} /> : null}
      {load.data?.native === null ? <Text style={ui.error}>Системный список Android недоступен.</Text> : null}
      {load.data?.reminders.filter(reminder => reminder.state !== 'error' && reminder.due_at > now).slice(0, 12).map(reminder => {
        const verified = load.data?.native?.get(reminder.provider_id) === reminder.due_at;
        return <View key={reminder.provider_id} style={ui.card}><Text style={ui.body}>{reminder.title}</Text>
          <Text style={ui.muted}>{formatDate(reminder.due_at)} · {verified ? 'Есть в очереди Android' : 'Ожидает подтверждения Android'}</Text></View>;
      })}
      {load.data?.reviews.cold.length ? <ActionButton label={`Проверить актуальность · ${load.data.reviews.cold.length}`} secondary onPress={() => router.navigate('/')} /> : null}
      {load.data?.reviews.archive.length ? <ActionButton label={`Проверить архив · ${load.data.reviews.archive.length}`} secondary onPress={() => router.navigate('/archive?review=due')} /> : null}
      {load.data?.reminders.filter(reminder => reminder.state === 'error' && reminder.due_at > now).map(reminder => <Pressable accessibilityRole="button" key={reminder.task_id} style={ui.card} onPress={() => router.push({ pathname: '/task/[id]', params: { id: reminder.task_id } })}><Text style={ui.error}>{reminder.title}: напоминание не запланировано</Text><Text style={ui.muted}>{reminder.error}</Text></Pressable>)}
    </View>}
    ListEmptyComponent={!load.loading && !load.error ? <Empty title="Событий пока нет" body="Журнал заполнится при планировании, открытии и отмене напоминаний." icon="bell-outline" /> : null}
    ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
    renderItem={({ item }) => <Pressable accessibilityRole="button" disabled={!item.task_id && !item.vehicle_id} style={ui.card} onPress={() => { if (item.task_id) router.push({ pathname: '/task/[id]', params: { id: item.task_id } }); else if (item.vehicle_id) router.push({ pathname: '/vehicle/[id]', params: { id: item.vehicle_id } }); }}>
      <Text style={{ color: item.event === 'opened' ? colors.accent : colors.muted, fontSize: 12 }}>{labels[item.event] || item.event} · {formatDate(item.created_at)}</Text><Text style={ui.body}>{item.title || 'Локальное уведомление Auto CRM'}</Text>
    </Pressable>} />;
}
