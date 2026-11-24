import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Alert, FlatList, Linking, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActionButton } from '../components/action-button';
import { ArchiveDeleteDialog } from '../components/archive-delete-dialog';
import { ConfirmDialog } from '../components/confirm-dialog';
import { VehicleLinkRow } from '../components/vehicle-link-row';
import { useNow } from '../components/clock';
import { reviewDays, reviewSetting, vehicleReviewDue } from '../domain/vehicle-review';
import { Chips, Empty, Field, Icon, IconButton, LoadState, Page, useLoad } from '../components/kit';
import { MediaGallery } from '../components/media-gallery';
import { StoredImage } from '../components/stored-image';
import { TaskRow } from '../components/task-row';
import { reasonLabels, statusLabels, substatusLabels, vehicleName, type CompletionReason } from '../domain/models';
import { isNewPastDeadline } from '../domain/task-deadline';
import { displayRubles } from '../domain/money';
import { MoneyField } from '../components/money-field';
import { DeadlineFields } from '../components/deadline-fields';
import { useDiscardDraft } from '../components/discard-draft';
import { RevealField, useFormScroll, useKeyboardVisible } from '../components/form-scroll';
import { DetailTabs } from '../components/main-tabs';
import { reconcileReminders } from '../services/task-reminders';
import { useRepository } from '../storage/app-provider';
import { formatDate, useTheme } from '../theme';

export function VehicleScreen() {
  const { colors, ui } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>(); const repository = useRepository(), now = useNow();
  const insets = useSafeAreaInsets();
  const load = useLoad(useCallback(async () => ({
    detail: await repository.getVehicle(id), tasks: await repository.listTasks(id),
    coldDays: reviewDays('cold', await repository.getSetting(reviewSetting.cold)),
    archiveDays: reviewDays('archive', await repository.getSetting(reviewSetting.archive)),
  }), [repository, id]));
  const [tab, setTab] = useState('general'), [note, setNote] = useState(''), [noteId, setNoteId] = useState<string | undefined>(), [query, setQuery] = useState(''), [descending, setDescending] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [promotion, setPromotion] = useState(false), [buyout, setBuyout] = useState(''), [market, setMarket] = useState(''), [next, setNext] = useState(''), [due, setDue] = useState(() => new Date(Date.now() + 86400000));
  const lock = useRef(false), historyList = useRef<FlatList>(null);
  const { viewport, focus, onLayout, onScroll } = useFormScroll(useCallback(offset => historyList.current?.scrollToOffset({ offset, animated: true }), []));
  const keyboard = useKeyboardVisible();
  const [archiveComment, setArchiveComment] = useState('');
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null), [reviewOpen, setReviewOpen] = useState(false);
  const discardDraftDialog = useDiscardDraft(!!note || !!noteId || promotion || !!archiveComment, busy, () => lock.current);
  const [archiving, setArchiving] = useState(false), [reason, setReason] = useState<CompletionReason>('bought');
  const detail = load.data?.detail, car = detail?.vehicle;
  async function mutate(action: () => Promise<unknown>, after?: () => void) {
    if (lock.current) return; lock.current = true; setBusy(true); setError(null);
    try { await action(); after?.(); void reconcileReminders(repository).catch(() => undefined); await load.refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Операция не выполнена. Изменения черновика сохранены на экране.'); }
    finally { lock.current = false; setBusy(false); }
  }
  function openUrl(url: string) { void Linking.openURL(url).catch(() => Alert.alert('Не удалось открыть', 'На устройстве нет подходящего приложения. Ссылку можно скопировать из карточки.')); }
  const shell = (content: ReactNode) => <View style={ui.screen}>
    {content}
    {!keyboard ? <DetailTabs selected={car?.status === 'completed' ? 'archive' : 'lots'} /> : null}
    {discardDraftDialog}
  </View>;
  if (load.loading && !load.data || load.error) return shell(<Page tabInset><LoadState loading={load.loading} error={load.error} retry={() => { void load.refresh(); }} /></Page>);
  if (!car || !detail) return shell(<Page tabInset><Empty title="Автомобиль не найден" body="Откройте список и выберите карточку ещё раз." /></Page>);
  const cover = detail.attachments.find(item => item.id === car.cover_id && item.mime_type.startsWith('image/')) || detail.attachments.find(item => item.mime_type.startsWith('image/'));
  const reviewKind = car.status === 'completed' ? 'archive' : 'cold';
  const reviewDue = vehicleReviewDue(car, reviewKind, reviewKind === 'archive' ? load.data!.archiveDays : load.data!.coldDays);
  const listContent = [ui.listContent, { paddingLeft: 16 + insets.left, paddingRight: 16 + insets.right, paddingBottom: 16 }];
  const header = <View style={{ gap: 8 }}>
    {cover && tab === 'general' ? <Pressable accessibilityRole="button" accessibilityLabel="Открыть фото автомобиля" onPress={() => router.navigate({ pathname: '/media/[id]', params: { id: cover.id, vehicleId: id } })}><StoredImage key={cover.id} path={cover.relative_path} /></Pressable> : null}
    <View style={ui.row}><View style={{ flex: 1, gap: 3 }}><Text selectable style={ui.title}>{vehicleName(car)}</Text><Text style={ui.muted}>{[car.year, car.mileage && `${car.mileage} км`, car.lot_type === 'corporate' ? 'Корпоративный лот' : 'Обычный лот'].filter(Boolean).join(' · ')}</Text></View><IconButton name="pencil-outline" label="Редактировать автомобиль" onPress={() => router.navigate({ pathname: '/vehicle/edit', params: { id } })} /></View>
    <Text style={[ui.status, { color: car.status === 'completed' ? colors.success : colors.accent }]}>{car.completion_reason ? reasonLabels[car.completion_reason] : statusLabels[car.status]}{car.substatus ? ` · ${substatusLabels[car.substatus]}` : ''}</Text>
    {car.archived_at != null ? <Text style={ui.muted}>Завершено {new Date(car.archived_at).toLocaleDateString('ru-RU')}</Text> : null}
    <Chips value={tab} choices={[[ 'general', 'Общее' ], [ 'history', 'История' ], [ 'tasks', 'Задачи' ], [ 'files', 'Файлы' ]]} onChange={setTab} />
    {error ? <Text accessibilityRole="alert" style={ui.error}>{error}</Text> : null}
  </View>;
  if (tab === 'files') return shell(<MediaGallery vehicleId={id} items={detail.attachments} header={header} onChanged={() => { void load.refresh(); }} />);
  if (tab === 'tasks') return shell(<FlatList style={ui.screen} data={load.data?.tasks} keyExtractor={task => task.id} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={listContent}
    ListHeaderComponent={<View style={{ gap: 8, marginBottom: 8 }}>{header}{car.status === 'completed' ? <Text style={ui.muted}>Чтобы добавить задачу, верните автомобиль из архива.</Text> : <ActionButton label="Следующее действие" compact onPress={() => router.push({ pathname: '/task/new', params: { vehicleId: id } })} />}</View>}
    ItemSeparatorComponent={() => <View style={{ height: 10 }} />} renderItem={({ item }) => <TaskRow task={item} onChanged={() => { void load.refresh(); }} />} ListEmptyComponent={<Empty title="Следующее действие ещё не задано" body="Укажите, когда позвонить, приехать на осмотр или уточнить цену." icon="calendar-plus" />} />);
  if (tab === 'history') {
    const history = [...detail.notes.map(item => ({ ...item, kind: 'note' })), ...detail.events].filter(item => item.body.toLocaleLowerCase('ru-RU').includes(query.toLocaleLowerCase('ru-RU'))).sort((a, b) => (descending ? -1 : 1) * (a.created_at - b.created_at || a.id.localeCompare(b.id)));
    return shell(<View ref={viewport} collapsable={false} onLayout={onLayout} style={{ flex: 1 }}>
      <RevealField.Provider value={focus}>
      <FlatList ref={historyList} onScroll={onScroll} scrollEventThrottle={16} scrollsChildToFocus={false} style={ui.screen} data={history} keyExtractor={item => item.id} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={listContent}
      ListHeaderComponent={<View style={{ gap: 8, marginBottom: 8 }}>{header}
        <Field label={noteId ? 'Редактировать заметку' : 'Новая заметка'} value={note} onChangeText={setNote} editable={!busy} multiline maxLength={10000} placeholder="Разговор, осмотр, договорённости…" />
        <ActionButton label={busy ? 'Сохраняем…' : noteId ? 'Сохранить изменения заметки' : 'Добавить заметку'} disabled={busy || !note.trim()} onPress={() => { void mutate(() => repository.saveNote(id, note, noteId), () => { setNote(''); setNoteId(undefined); }); }} />
        {noteId ? <ActionButton label="Отменить редактирование" secondary disabled={busy} onPress={() => { setNote(''); setNoteId(undefined); }} /> : null}
        <Field label="Найти в истории" value={query} onChangeText={setQuery} placeholder="Текст заметки или события" />
        <Chips value={descending ? 'desc' : 'asc'} choices={[[ 'desc', 'Сначала новые' ], [ 'asc', 'Сначала старые' ]]} onChange={value => setDescending(value === 'desc')} />
      </View>}
      ListEmptyComponent={<Empty title="История без совпадений" body="Попробуйте другой запрос или добавьте заметку." icon="text-box-outline" />}
      renderItem={({ item }) => <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ width: 32, alignItems: 'center' }}><View style={ui.glyph}><Icon name={item.kind === 'note' ? 'note-text-outline' : 'timeline-clock-outline'} size={17} /></View><View style={{ backgroundColor: colors.border, width: 1, flex: 1 }} /></View>
        <View style={[ui.card, { flex: 1, minWidth: 0, gap: 4, marginBottom: 8 }]}><Text style={[ui.muted, { color: item.kind === 'note' ? colors.accent : colors.muted }]}>{item.kind === 'note' ? 'Заметка' : 'Событие'} · {formatDate(item.created_at)}</Text><Text selectable style={ui.body}>{item.body}</Text>
          {item.kind === 'note' ? <ActionButton label="Редактировать" secondary compact disabled={busy || !!note || !!noteId} onPress={() => { setNote(item.body); setNoteId(item.id); historyList.current?.scrollToOffset({ offset: 0 }); }} /> : null}</View>
      </View>} />
      </RevealField.Provider>
    </View>);
  }
  const pending = load.data?.tasks.some(task => task.status === 'pending');
  return shell(<><Page tabInset avoidAndroidKeyboard>{header}
    {reviewDue !== null && reviewDue <= now ? <ActionButton label={reviewKind === 'cold' ? 'Проверить актуальность' : 'Автомобиль давно в архиве'} secondary onPress={() => setReviewOpen(true)} /> : null}
    <ConfirmDialog title={reviewKind === 'cold' ? 'Проверить актуальность' : 'Автомобиль давно в архиве'} visible={reviewOpen} busy={busy} onClose={() => setReviewOpen(false)}>
      <Text style={ui.muted}>{vehicleName(car)}</Text>
      {([['keep', reviewKind === 'cold' ? 'Оставить актуальным' : 'Оставить в архиве'], ['snooze3', 'Отложить на 3 дня'], ['snooze7', 'Отложить на 7 дней']] as const).map(([action, label]) =>
        <ActionButton key={action} label={label} secondary={action !== 'keep'} disabled={busy} onPress={() => { void mutate(() => repository.resolveReview(id, reviewKind, action), () => setReviewOpen(false)); }} />)}
      {reviewKind === 'archive' ? <>
        <ActionButton label="Вернуть в активные" secondary disabled={busy} onPress={() => { void mutate(() => repository.changeStage(id, 'cold'), () => setReviewOpen(false)); }} />
        <ActionButton label="Удалить автомобиль" secondary disabled={busy} onPress={() => { setReviewOpen(false); setDeleteIds([id]); }} />
      </> : <>
        <ActionButton label="Перевести в работу" secondary disabled={busy} onPress={() => { setReviewOpen(false); setBuyout(car.buyout_price); setMarket(car.market_price); setPromotion(true); }} />
        <ActionButton label="В архив" secondary disabled={busy} onPress={() => { setReviewOpen(false); setArchiving(true); }} />
      </>}
    </ConfirmDialog>
    <View style={ui.card}>
      <View style={ui.row}><View style={{ flex: 1, gap: 5 }}><Text selectable style={ui.body}>{car.phone || 'Телефон не указан'}</Text><Text selectable style={ui.muted}>{car.seller || 'Продавец не указан'}</Text></View>
        {car.phone ? <><IconButton name="phone-outline" label="Позвонить продавцу" onPress={() => openUrl(`tel:${car.phone.replace(/[^+\d]/g, '')}`)} /><IconButton name="whatsapp" label="Написать в WhatsApp" onPress={() => openUrl(`https://wa.me/${car.phone.replace(/\D/g, '')}`)} /></> : null}</View>
      {car.source_url ? <VehicleLinkRow value={car.source_url} /> : null}
      {car.autoteka_url ? <VehicleLinkRow value={car.autoteka_url} /> : null}
    </View>
    <View style={ui.card}>
      <Text style={ui.heading}>Оценка и расходы</Text>
      <View style={[ui.row, { flexWrap: 'wrap', alignItems: 'stretch' }]}>
        {([['Наша цена', car.buyout_price], ['Рынок', car.market_price]] as const).map(([label, value]) => <View key={label} style={{ flexGrow: 1, flexBasis: 104, padding: 9, gap: 3, borderRadius: 10, backgroundColor: colors.raised }}><Text style={ui.muted}>{label}</Text><Text selectable style={[ui.heading, { color: label === 'Наша цена' ? colors.success : colors.text }]}>{value ? displayRubles(value) : '—'}</Text></View>)}
      </View>
      {([['Цена продавца', displayRubles(car.listing_price)], ['Подготовка', displayRubles(car.prep_cost)], ['Куплено за', displayRubles(car.purchase_price)], ['Дата покупки', car.purchase_date]] as const).filter(([, value]) => !!value).map(([label, value]) => <View key={label} style={[ui.row, { alignItems: 'flex-start', paddingVertical: 3 }]}><Text style={[ui.muted, { flex: 1 }]}>{label}</Text><Text selectable style={[ui.body, { flex: 1, textAlign: 'right', fontWeight: '600' }]}>{value}</Text></View>)}
    </View>
    {car.inspection_place || car.inspection_at ? <View style={ui.card}><Text style={ui.heading}>Осмотр</Text><Text selectable style={ui.body}>{[car.inspection_place, car.inspection_at].filter(Boolean).join('\n')}</Text></View> : null}
    <View style={{ gap: 10 }}><Text style={ui.heading}>Стадия и архив</Text>
      {car.status === 'completed' ? <><ActionButton label="Вернуть в активные" disabled={busy} onPress={() => { void mutate(() => repository.changeStage(id, 'cold')); }} />
        <ActionButton label="Удалить из CRM" secondary disabled={busy} onPress={() => setDeleteIds([id])} /></> : <>
        <Chips value={car.status} choices={[[ 'cold', 'Контакт' ], [ 'in_progress', 'Осмотр / в работе' ]]} onChange={status => {
          if (status === 'in_progress') { setBuyout(car.buyout_price); setMarket(car.market_price); setPromotion(true); }
          else void mutate(() => repository.changeStage(id, status));
        }} />
        {promotion ? <View style={ui.card}><Text style={ui.heading}>Подготовить следующий шаг</Text><MoneyField label="Оценка выкупа" value={buyout} onChangeText={setBuyout} editable={!busy} /><MoneyField label="Рыночная оценка" value={market} onChangeText={setMarket} editable={!busy} />
          {!pending ? <><Field label="Следующее действие" value={next} onChangeText={setNext} placeholder="Перезвонить, осмотреть…" editable={!busy} />
            <DeadlineFields value={due} disabled={busy} onChange={value => { setDue(value); setError(null); }} onError={setError} />
          </> : <Text style={ui.muted}>Следующее действие уже запланировано.</Text>}
          <ActionButton label="Перевести в работу" disabled={busy} onPress={() => {
            if (!pending && isNewPastDeadline(due, undefined, Date.now())) { setError('Укажите будущий срок следующего действия.'); return; }
            void mutate(() => repository.promote(id, buyout, market, next, due.getTime()), () => setPromotion(false));
          }} />
          <ActionButton label="Отмена" secondary disabled={busy} onPress={() => setPromotion(false)} /></View> : null}
        <ActionButton label="Завершить и перенести в архив" secondary disabled={busy} onPress={() => setArchiving(value => !value)} />
        {archiving ? <View style={ui.card}><Text style={ui.heading}>Причина завершения</Text><Chips value={reason} choices={Object.entries(reasonLabels) as [CompletionReason, string][]} onChange={setReason} />
          <Field label="Комментарий · необязательно" value={archiveComment} onChangeText={setArchiveComment} multiline maxLength={10000} editable={!busy} />
          <Text style={ui.muted}>История и файлы сохранятся. Напоминания этого автомобиля будут отменены.</Text>
          <ActionButton label="Перенести в архив" disabled={busy} onPress={() => { void mutate(() => repository.changeStage(id, 'completed', reason, archiveComment), () => { setArchiving(false); setArchiveComment(''); }); }} />
          <ActionButton label="Отмена" secondary disabled={busy} onPress={() => { setArchiving(false); setArchiveComment(''); }} /></View> : null}
      </>}
    </View>
  </Page>{!keyboard ? <View style={[ui.row, { borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: 4, paddingLeft: 12 + insets.left, paddingRight: 12 + insets.right, backgroundColor: colors.background }]}>{car.phone ? <View style={{ flex: 1 }}><ActionButton label="Позвонить" onPress={() => openUrl(`tel:${car.phone.replace(/[^+\d]/g, '')}`)} /></View> : null}<View style={{ flex: 1 }}><ActionButton label="Добавить запись" secondary={!!car.phone} onPress={() => setTab('history')} /></View></View> : null}
  {deleteIds ? <ArchiveDeleteDialog ids={deleteIds} onClose={() => setDeleteIds(null)} onDone={message => { setDeleteIds(null); Alert.alert(message); router.replace('/archive'); }} /> : null}
  </>);
}
