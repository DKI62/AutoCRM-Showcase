import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActionButton } from '../components/action-button';
import { Chips, Empty, Field, IconButton } from '../components/kit';
import { VehicleRow } from '../components/vehicle-row';
import { ArchiveDeleteDialog } from '../components/archive-delete-dialog';
import { SelectionToolbar } from '../components/confirm-dialog';
import { calendarDaysAfter, reviewDays, reviewSetting } from '../domain/vehicle-review';
import { vehicleName } from '../domain/models';
import type { VehicleSummary } from '../repositories/crm-repository';
import { useRepository } from '../storage/app-provider';
import { useTheme } from '../theme';

export function LotsScreen({ archive = false }: { archive?: boolean }) {
  const { colors, ui } = useTheme();
  const repository = useRepository(), insets = useSafeAreaInsets();
  const { stage, review } = useLocalSearchParams<{ stage?: string; review?: string }>();
  const [query, setQuery] = useState(''), [type, setType] = useState(''), [selectedStatus, setSelectedStatus] = useState(''), [substatus, setSubstatus] = useState(''), [reason, setReason] = useState(''), [filters, setFilters] = useState(false);
  const [search, setSearch] = useState('');
  const [archiveView, setArchiveView] = useState('all');
  const [selection, setSelection] = useState<string[] | null>(null), [deleting, setDeleting] = useState<string[] | null>(null), [message, setMessage] = useState('');
  const activeArchiveView = review === 'due' ? 'due' : archiveView;
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 180);
    return () => clearTimeout(timer);
  }, [query]);
  const status = stage === 'in_progress' || stage === 'cold' ? stage : selectedStatus;
  function setStatus(value: string) { setSelectedStatus(value); if (stage) router.setParams({ stage: undefined }); }
  const [items, setItems] = useState<VehicleSummary[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [hasMore, setHasMore] = useState(false);
  const request = useRef(0), lock = useRef(false);
  const load = useCallback(async (offset = 0) => {
    if (offset && lock.current) return; const token = ++request.current; lock.current = true; setLoading(true); setError(null);
    try {
      const now = Date.now();
      const days = archive && activeArchiveView === 'due' ? reviewDays('archive', await repository.getSetting(reviewSetting.archive)) : 0;
      const rows = archive && activeArchiveView === 'due' && !days ? [] : await repository.listVehicles(offset, 50, { query: search, lotType: type, status, substatus, reason, archive,
        ...(archive && activeArchiveView === 'recent' ? { archivedSince: calendarDaysAfter(now, -7) } : {}),
        ...(archive && activeArchiveView === 'due' ? { archivedBefore: calendarDaysAfter(now, -days), reviewAt: now } : {}),
      });
      if (token !== request.current) return; setItems(previous => offset ? [...previous, ...rows] : rows); setHasMore(rows.length === 50);
    } catch (cause) { if (token === request.current) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить автомобили.'); }
    finally { if (token === request.current) { setLoading(false); lock.current = false; } }
  }, [repository, search, type, status, substatus, reason, archive, activeArchiveView]);
  useFocusEffect(useCallback(() => {
    setItems([]); setHasMore(false); void load();
    const unsubscribe = repository.subscribe(() => { void load(); });
    return () => { unsubscribe(); request.current++; lock.current = false; };
  }, [load, repository]));
  return <View style={ui.screen}>
    <FlatList data={items} keyExtractor={item => item.id} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled"
      contentContainerStyle={[ui.listContent, { flexGrow: 1, paddingLeft: 16 + insets.left, paddingRight: 16 + insets.right }]}
      refreshing={loading && items.length > 0} onRefresh={() => { void load(); }} onEndReached={() => { if (hasMore && !error) void load(items.length); }}
      ListHeaderComponent={<View style={{ gap: 8, marginBottom: 8 }}>
        <View style={[ui.row, { alignItems: 'flex-end' }]}><View style={{ flex: 1, minWidth: 0 }}><Field label={archive ? 'Поиск в архиве' : 'Поиск по авто и истории'} value={query} onChangeText={setQuery} placeholder="Авто, продавец, телефон" returnKeyType="search" /></View><IconButton name="tune-variant" label="Фильтры" onPress={() => setFilters(v => !v)} /></View>
        <Chips value={type} choices={[[ '', 'Все лоты' ], [ 'regular', 'Обычные' ], [ 'corporate', 'Корпоративные' ]]} onChange={setType} />
        {archive ? <View style={ui.row}><View style={{ flex: 1, minWidth: 0 }}><Chips value={activeArchiveView} choices={[[ 'all', 'Все' ], [ 'recent', 'Недавние' ], [ 'due', 'Требуют проверки' ]]} onChange={value => {
          setArchiveView(value); setSelection(null); if (review) router.setParams({ review: undefined });
        }} /></View>{items.length ? <IconButton name="checkbox-multiple-marked-outline" label="Выбрать архивные карточки" onPress={() => setSelection([])} /> : null}</View> : null}
        {selection ? <SelectionToolbar count={selection.length} onRemove={() => setDeleting(selection)} onCancel={() => setSelection(null)} /> : null}
        {message ? <Text accessibilityLiveRegion="polite" style={ui.muted}>{message}</Text> : null}
        {filters || stage === 'in_progress' || stage === 'cold' ? <View style={ui.card}>
          {archive ? <><Text style={ui.label}>Причина завершения</Text><Chips value={reason} choices={[[ '', 'Все причины' ], [ 'bought', 'Куплено' ], [ 'sold_elsewhere', 'Продано другому' ], [ 'declined', 'Отказ' ], [ 'other', 'Другое' ]]} onChange={setReason} /></> : <><Text style={ui.label}>Стадия</Text><Chips value={status} choices={[[ '', 'Все стадии' ], [ 'cold', 'Контакт' ], [ 'in_progress', 'Осмотр / в работе' ]]} onChange={setStatus} /></>}
          <Text style={ui.label}>Подстатус</Text><Chips value={substatus} choices={[[ '', 'Все' ], [ 'bargaining', 'Торгуемся' ], [ 'awaiting_decision', 'Ждём решение' ], [ 'documents', 'Документы' ]]} onChange={setSubstatus} />
          <ActionButton label="Сбросить фильтры" secondary compact onPress={() => { setType(''); setStatus(''); setSubstatus(''); setReason(''); setQuery(''); }} />
        </View> : null}
      </View>}
      ListEmptyComponent={loading ? <ActivityIndicator color={colors.accent} /> : !error ? <Empty title={query || type || status || substatus || reason ? 'Ничего не найдено' : archive ? 'Архив пока пуст' : 'Ваш первый автомобиль'} body={archive ? 'Завершённые лоты появятся здесь. Их можно вернуть в работу.' : 'Добавьте карточку на вкладке «Добавить» или отправьте фото через «Поделиться».'} /> : null}
      ItemSeparatorComponent={() => <View style={{ height: 9 }} />} renderItem={({ item }) => selection && archive
        ? <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selection.includes(item.id) }} onPress={() => setSelection(previous => previous?.includes(item.id) ? previous.filter(id => id !== item.id) : [...previous ?? [], item.id])} style={[ui.card, ui.row]}>
          <Text style={[ui.heading, { color: colors.accent }]}>{selection.includes(item.id) ? '☑' : '☐'}</Text><Text style={ui.body}>{vehicleName(item)}</Text>
        </Pressable> : <VehicleRow item={item} />}
      ListFooterComponent={error ? <View style={{ gap: 12 }}><Text accessibilityRole="alert" style={ui.error}>{error}</Text><ActionButton label="Повторить" onPress={() => { void load(); }} /></View> : loading && items.length ? <ActivityIndicator color={colors.accent} /> : null} />
    {deleting ? <ArchiveDeleteDialog ids={deleting} onClose={() => setDeleting(null)} onDone={value => { setDeleting(null); setSelection(null); setMessage(value); }} /> : null}
  </View>;
}
