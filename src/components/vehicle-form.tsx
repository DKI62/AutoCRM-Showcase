import { useEffect, useRef, useState } from 'react';
import { Alert, Switch, Text, View } from 'react-native';
import { detailFields, type Vehicle, type VehicleInput } from '../domain/models';
import { moneyFields } from '../domain/money';
import type { ManagedImage } from '../repositories/crm-repository';
import { acceptMediaCopies, assertReadyMedia, compensateMediaCopies, discardImage } from '../services/image-files';
import { pickMedia } from '../services/media-picker';
import type { IncomingDraft } from '../services/incoming-share';
import { useRepository } from '../storage/app-provider';
import { useTheme } from '../theme';
import { ActionButton } from './action-button';
import { Chips, Field, Icon, Page } from './kit';
import { StoredImage } from './stored-image';
import { MoneyField } from './money-field';
import { useDiscardDraft } from './discard-draft';

const labels = {
  seller: 'Продавец / контактное лицо', phone: 'Телефон', year: 'Год', mileage: 'Пробег', listing_price: 'Цена продавца', buyout_price: 'Оценка выкупа',
  market_price: 'Рыночная оценка', prep_cost: 'Расходы на подготовку', purchase_price: 'Фактическая цена покупки', purchase_date: 'Дата покупки',
  autoteka_url: 'Ссылка на Автотеку', inspection_place: 'Место осмотра', inspection_at: 'Дата и время осмотра',
};
function discardDraft(files: ManagedImage[]) {
  for (const file of files) { try { discardImage(file); } catch { /* Retain on I/O error. */ } }
}
export function VehicleForm({ initial, initialMedia = [], initialNote = '', initialUrl = '', onSaved, incomingDraft, onShareConsumed, onShareCancelled }: {
  initial?: Vehicle; initialMedia?: ManagedImage[]; initialNote?: string; initialUrl?: string; onSaved: (id: string, nextTask: boolean) => void;
  incomingDraft?: IncomingDraft | null; onShareConsumed?: () => void; onShareCancelled?: () => void;
}) {
  const { colors, ui } = useTheme();
  const repository = useRepository();
  const [input, setInput] = useState<VehicleInput>(() => ({ make: initial?.make ?? '', model: initial?.model ?? '', title: initial?.title ?? '', note: initialNote,
    sourceUrl: initial?.source_url ?? initialUrl, lot_type: initial?.lot_type ?? 'regular', substatus: initial?.substatus ?? '',
    ...Object.fromEntries(detailFields.map(key => [key, initial?.[key] ?? ''])) }));
  const [media, setMedia] = useState(initialMedia), [expanded, setExpanded] = useState(!!initial), [dirty, setDirty] = useState(initialMedia.length > 0 || !!initialNote || !!initialUrl);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [nextTask, setNextTask] = useState(false);
  const lock = useRef(false), committed = useRef(false), owned = useRef(initialMedia), mounted = useRef(true);
  const [savedId, setSavedId] = useState<string | null>(null); const delivered = useRef(false);
  const merging = useRef<IncomingDraft | null>(null);
  useEffect(() => {
    if (!incomingDraft || merging.current === incomingDraft || busy || committed.current) return;
    merging.current = incomingDraft;
    function merge() {
      owned.current = [...owned.current, ...incomingDraft!.images]; setMedia(owned.current); setDirty(true);
      setInput(previous => ({ ...previous, note: [previous.note, incomingDraft!.note].filter(Boolean).join('\n'), sourceUrl: previous.sourceUrl || incomingDraft!.sourceUrl || '' }));
      onShareConsumed?.();
    }
    if (dirty) Alert.alert('Добавить в текущий черновик?', 'Ваши поля и выбранные ранее файлы сохранятся. Новые файлы и текст будут добавлены.', [
      { text: 'Назад', style: 'cancel', onPress: () => { merging.current = null; onShareCancelled?.(); } }, { text: 'Добавить', onPress: merge },
    ], { cancelable: false });
    else merge();
  }, [incomingDraft, busy, dirty, onShareConsumed, onShareCancelled]);
  useEffect(() => { if (savedId && !delivered.current) { delivered.current = true; onSaved(savedId, nextTask); } }, [savedId, onSaved, nextTask]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; void Promise.resolve().then(() => {
    if (!mounted.current && !committed.current && !lock.current) return compensateMediaCopies(repository, owned.current);
  }); }; }, [repository]);
  const discardDraftDialog = useDiscardDraft(!savedId && dirty, !savedId && busy, () => lock.current);
  function update<K extends keyof VehicleInput>(key: K, value: VehicleInput[K]) { setInput(previous => ({ ...previous, [key]: value })); setDirty(true); }
  async function choose(source: 'gallery' | 'camera' | 'files') {
    if (lock.current) return; lock.current = true; setBusy(true); setError(null);
    try {
      const files = await pickMedia(source);
      if (!mounted.current) { discardDraft(files); return; }
      owned.current = [...owned.current, ...files]; setMedia(owned.current); if (files.length) setDirty(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось импортировать медиа.'); }
    finally { lock.current = false; if (mounted.current) setBusy(false); else discardDraft(owned.current); }
  }
  async function save() {
    if (lock.current || committed.current) return; lock.current = true; setBusy(true); setError(null);
    try {
      let id: string;
      assertReadyMedia(owned.current);
      if (initial) { await repository.updateVehicle(initial.id, input, owned.current); id = initial.id; }
      else id = await repository.createVehicle(input, owned.current);
      committed.current = true;
      acceptMediaCopies(owned.current);
      if (mounted.current) { setDirty(false); setSavedId(id); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Не удалось сохранить. Черновик оставлен открытым.'); }
    finally {
      lock.current = false;
      if (mounted.current) setBusy(false); else if (!committed.current) void compensateMediaCopies(repository, owned.current);
    }
  }
  return <Page avoidAndroidKeyboard tabInset={!initial} footer={<>
    {error ? <Text accessibilityRole="alert" style={ui.error}>{error}</Text> : null}
    <ActionButton label={busy ? 'Подождите…' : 'Сохранить'} disabled={busy || !!savedId} onPress={() => { void save(); }} />
  </>}>
    {discardDraftDialog}
    <Chips value={input.lot_type ?? 'regular'} choices={[[ 'regular', 'Обычный лот' ], [ 'corporate', 'Корпоративный' ]]} onChange={value => update('lot_type', value)} />
    <View style={ui.card}><View style={ui.row}><Icon name="image-plus" size={20} /><Text style={[ui.muted, { flex: 1 }]}>{initial ? 'Добавить к карточке фото и видео' : 'Фото и видео · необязательно'}</Text></View>
      {media.length ? <View style={[ui.row, { flexWrap: 'wrap' }]}>{media.map(item => <View key={item.relative_path} style={{ gap: 4, width: 82 }}>
        {item.mime_type.startsWith('image/') ? <StoredImage path={item.relative_path} compact /> : <View style={{ height: 76, justifyContent: 'center', alignItems: 'center' }}><Icon name="play-circle-outline" size={30} /></View>}
        <Text onPress={() => { if (lock.current) return; try { discardImage(item); owned.current = owned.current.filter(file => file !== item); setMedia(owned.current); } catch { setError('Не удалось убрать файл.'); } }} accessibilityRole="button" accessibilityLabel="Убрать файл из черновика" style={{ color: colors.danger, paddingVertical: 10 }}>Убрать</Text>
      </View>)}</View> : null}
      <ActionButton label={busy ? 'Копируем…' : 'Выбрать фото / видео'} secondary disabled={busy} onPress={() => { void choose('gallery'); }} />
      <View style={ui.row}><View style={{ flex: 1 }}><ActionButton label="Камера" secondary disabled={busy} onPress={() => { void choose('camera'); }} /></View><View style={{ flex: 1 }}><ActionButton label="Файлы" secondary disabled={busy} onPress={() => { void choose('files'); }} /></View></View>
    </View>
    {!initial ? <Field label="Итоги разговора" value={input.note} multiline style={{ minHeight: 66 }} maxLength={10000} editable={!busy} placeholder="О чём договорились?" onChangeText={value => update('note', value)} /> : null}
    <Field label="Телефон продавца" value={input.phone ?? ''} keyboardType="phone-pad" editable={!busy} placeholder="+7…" onChangeText={value => update('phone', value)} />
    <Field label="Название" value={input.title ?? ''} maxLength={160} editable={!busy} placeholder="Название или телефон" onChangeText={value => update('title', value)} />
    <View style={{ flexDirection: 'row', gap: 10 }}><View style={{ flex: 1 }}><Field label="Марка" value={input.make} maxLength={100} editable={!busy} placeholder="BMW" onChangeText={value => update('make', value)} /></View>
      <View style={{ flex: 1 }}><Field label="Модель" value={input.model} maxLength={100} editable={!busy} placeholder="5 (G30)" onChangeText={value => update('model', value)} /></View></View>
    <Field label="Продавец" value={input.seller ?? ''} editable={!busy} onChangeText={value => update('seller', value)} />
    <Field label="Ссылка на объявление" value={input.sourceUrl ?? ''} autoCapitalize="none" keyboardType="url" editable={!busy} onChangeText={value => update('sourceUrl', value)} />
    <Field label="Ссылка на Автотеку" value={input.autoteka_url ?? ''} autoCapitalize="none" keyboardType="url" editable={!busy} onChangeText={value => update('autoteka_url', value)} />
    {!initial ? <View style={[ui.card, ui.row]}><Icon name="bell-outline" /><View style={{ flex: 1 }}><Text style={ui.body}>Создать напоминание</Text><Text style={ui.muted}>Открыть задачу после сохранения</Text></View><Switch accessibilityLabel="Создать напоминание после сохранения" value={nextTask} disabled={busy}
      trackColor={{ false: colors.controlBorder, true: colors.primary }} onValueChange={value => { setNextTask(value); setDirty(true); }} /></View> : null}
    <ActionButton label={expanded ? 'Свернуть дополнительные поля' : 'Цены и дополнительные поля'} secondary compact disabled={busy} onPress={() => setExpanded(value => !value)} />
    {expanded ? <>
      {detailFields.filter(key => !['phone', 'seller', 'autoteka_url'].includes(key)).map(key => moneyFields.has(key)
        ? <MoneyField key={key} label={labels[key]} value={input[key] ?? ''} editable={!busy} onChangeText={value => update(key, value)} />
        : <Field key={key} label={labels[key]} value={input[key] ?? ''} editable={!busy} maxLength={2000}
          placeholder={key === 'inspection_at' ? 'Например, 15 ноября в 14:00' : ''} onChangeText={value => update(key, value)} />)}
      <Text style={ui.label}>Подстатус</Text><Chips value={input.substatus ?? ''} choices={[[ '', 'Без подстатуса' ], [ 'bargaining', 'Торгуемся' ], [ 'awaiting_decision', 'Ждём решение' ], [ 'documents', 'Документы' ]]} onChange={value => update('substatus', value)} />
    </> : null}
  </Page>;
}
