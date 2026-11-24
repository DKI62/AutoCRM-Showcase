import { useNow } from '../components/clock';
import { vehicleName } from '../domain/models';
import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ActionButton } from '../components/action-button';
import { Chips, Empty, Icon, LoadState, Page, useLoad } from '../components/kit';
import { TaskRow } from '../components/task-row';
import { VehicleRow } from '../components/vehicle-row';
import { useRepository } from '../storage/app-provider';
import { useTheme } from '../theme';

export function HomeScreen() {
  const { colors, ui } = useTheme();
  const repository = useRepository(), now = useNow();
  const [stage, setStage] = useState(''), [showTasks, setShowTasks] = useState(false);
  const load = useLoad(useCallback(async () => {
    const end = new Date(now); end.setHours(24, 0, 0, 0);
    return { agenda: await repository.agenda(now, end.getTime()), stats: await repository.dashboard(), inspections: await repository.plannedInspections(),
      cars: await repository.listVehicles(0, 8, { status: stage }), review: await repository.reviews(now) };
  }, [repository, now, stage]));
  const agenda = load.data?.agenda;
  const refresh = () => { void load.refresh(); };
  return <Page footer={<ActionButton label="＋ Добавить автомобиль" onPress={() => router.navigate('/add')} />}>
    <Text style={ui.muted}>{new Date(now).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' })}</Text>
    <LoadState loading={load.loading && !load.data} error={load.error} retry={refresh} />
    {load.data && agenda ? <>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: showTasks }} onPress={() => setShowTasks(value => !value)} style={[ui.card, ui.row]}>
        <View style={[ui.glyph, { backgroundColor: colors.primarySoft }]}><Icon name="calendar-check-outline" size={18} /></View>
        <View style={{ flex: 1, minWidth: 0 }}><Text style={ui.heading}>Задачи на сегодня · {agenda.counts.today}</Text><Text style={ui.muted}>Просрочено: {agenda.counts.overdue}</Text></View>
        <Icon name={showTasks ? 'chevron-up' : 'chevron-right'} size={18} />
      </Pressable>
      {showTasks ? <>
      <Text style={ui.heading}>Ближайшие задачи</Text>
      <View style={[ui.row, { flexWrap: 'wrap', gap: 8 }]}><ActionButton label="Новая задача" compact onPress={() => router.push('/task/new')} /><ActionButton label="Все задачи" secondary compact onPress={() => router.navigate('/tasks')} /></View>
      {agenda.overdue.length ? <View style={{ gap: 6 }}><Text style={[ui.label, { color: colors.warning }]}>Просрочено · {agenda.counts.overdue}</Text>{agenda.overdue.map(task => <TaskRow key={task.id} task={task} onChanged={refresh} />)}</View> : null}
      {agenda.today.length ? <View style={{ gap: 6 }}><Text style={ui.label}>Сегодня · {agenda.counts.today}</Text>{agenda.today.map(task => <TaskRow key={task.id} task={task} onChanged={refresh} />)}</View> : null}
      {!agenda.overdue.length && !agenda.today.length ? <Empty title="На сегодня всё спокойно" body="Создайте задачу для автомобиля, чтобы запланировать звонок или осмотр." icon="calendar-check-outline" /> : null}
      {load.data.inspections.length ? <View style={{ gap: 6 }}><Text style={ui.heading}>Запланированные осмотры</Text>{load.data.inspections.map(car => <Pressable key={car.id} accessibilityRole="button" onPress={() => router.push({ pathname: '/vehicle/[id]', params: { id: car.id } })} style={[ui.card, ui.row]}><Icon name="calendar-outline" size={18} /><View style={{ flex: 1, minWidth: 0 }}><Text style={ui.body}>{vehicleName(car)}</Text><Text style={ui.muted}>{[car.inspection_at, car.inspection_place].filter(Boolean).join(' · ')}</Text></View></Pressable>)}</View> : null}
      {agenda.later.length ? <View style={{ gap: 6 }}><Text style={ui.heading}>Позже</Text>{agenda.later.map(task => <TaskRow key={task.id} task={task} onChanged={refresh} />)}</View> : null}
      </> : null}
      {agenda.counts.overdue || load.data.review.cold.length || load.data.review.archive.length ? <View style={ui.card}>
        <Text style={ui.heading}>Требуют внимания</Text>
        {agenda.counts.overdue ? <ActionButton label={`Просроченные задачи · ${agenda.counts.overdue}`} secondary compact onPress={() => router.navigate('/tasks')} /> : null}
        {load.data.review.cold.length ? <Text style={ui.muted}>Проверить актуальность · {load.data.review.cold.length}</Text> : null}
        {load.data.review.cold.slice(0, 3).map(car => <ActionButton key={car.id} label={vehicleName(car)} secondary compact onPress={() => router.navigate({ pathname: '/vehicle/[id]', params: { id: car.id } })} />)}
        {load.data.review.cold.length > 3 ? <ActionButton label="Все холодные карточки" secondary compact onPress={() => router.navigate('/lots?stage=cold')} /> : null}
        {load.data.review.archive.length ? <ActionButton label={`Старые карточки в архиве · ${load.data.review.archive.length}`} secondary compact onPress={() => router.navigate('/archive?review=due')} /> : null}
      </View> : null}
      <Text style={ui.heading}>Мои автомобили</Text>
      <Chips value={stage} choices={[[ '', `Все ${load.data.stats.active}` ], [ 'cold', `Холодные ${load.data.stats.active - load.data.stats.inspections}` ], [ 'in_progress', `В работе ${load.data.stats.inspections}` ]]} onChange={setStage} />
      {load.data.cars.map(car => <VehicleRow key={car.id} item={car} needsReview={load.data!.review.cold.some(item => item.id === car.id)} />)}
      {!load.data.cars.length ? <Empty title="Карточек нет" body="Выберите другую стадию или добавьте автомобиль." /> : null}
      <ActionButton label="Все автомобили" secondary compact onPress={() => router.navigate('/lots')} />
    </> : null}
  </Page>;
}
