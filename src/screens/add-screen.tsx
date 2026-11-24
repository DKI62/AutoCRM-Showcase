import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { ActionButton } from '../components/action-button';
import { Page } from '../components/kit';
import { VehicleChooser } from '../components/vehicle-chooser';
import { VehicleForm } from '../components/vehicle-form';
import { acceptMediaCopies, assertReadyMedia, discardImage } from '../services/image-files';
import { takeIncomingDrafts, type IncomingDraft } from '../services/incoming-share';
import { useRepository } from '../storage/app-provider';
import { useTheme } from '../theme';

export function AddScreen() {
  const { ui } = useTheme();
  const { incoming, shareError } = useLocalSearchParams<{ incoming?: string; shareError?: string }>();
  const repository = useRepository();
  const [drafts, setDrafts] = useState<IncomingDraft[]>([]), [mode, setMode] = useState<'new' | 'choose' | 'form'>('new'), [version, setVersion] = useState(0), [error, setError] = useState<string | null>(null);
  const [receiving, setReceiving] = useState(0), [attaching, setAttaching] = useState(false);
  const request = useRef<string | null>(null), lock = useRef(false), mounted = useRef(true);
  const draft = drafts[0];
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!incoming || request.current === incoming) return;
    request.current = incoming;
    const pending = takeIncomingDrafts();
    if (!pending.length) return;
    void Promise.resolve().then(() => { if (mounted.current) setReceiving(value => value + pending.length); });
    for (const item of pending) void item.then(value => {
      if (!mounted.current) { for (const file of value.images) { try { discardImage(file); } catch { /* Recovery keeps the journal. */ } } return; }
      if (value.images.length || value.note || value.sourceUrl) setDrafts(previous => [...previous, value]);
      else setError(value.error || 'Переданные файлы недоступны. Отправьте их снова.');
    }).catch(() => { if (mounted.current) setError('Не удалось прочитать переданные файлы.'); })
      .finally(() => { if (mounted.current) setReceiving(value => value - 1); });
  }, [incoming]);
  function clearDraft(value: IncomingDraft) { setDrafts(previous => previous.filter(item => item !== value)); setMode('new'); setError(null); }
  const choosing = !!draft && mode !== 'form';
  return <View style={ui.screen}>
    {!choosing && (error || shareError) ? <Text accessibilityRole="alert" style={[ui.error, { padding: 16 }]}>{error || 'Не удалось прочитать «Поделиться». Выберите файлы повторно.'}</Text> : null}
    {receiving > 0 ? <Text accessibilityLiveRegion="polite" style={[ui.muted, { padding: 16 }]}>Копируем переданные файлы…</Text> : null}
    {draft && choosing ? <Page>
    <Text style={ui.heading}>Получено через «Поделиться»</Text><Text style={ui.muted}>Файлов: {draft.images.length}. Выберите, куда сохранить.</Text>
    {error || draft.error ? <Text style={ui.error}>{error || draft.error}</Text> : null}
    {mode === 'new' ? <><ActionButton label="Новый автомобиль" onPress={() => setMode('form')} /><ActionButton label="К существующему автомобилю" secondary onPress={() => setMode('choose')} />
      <ActionButton label="Отменить импорт" secondary onPress={() => {
        for (const file of draft.images) { try { discardImage(file); } catch { /* Only these uncommitted copies; the journal can retry. */ } }
        clearDraft(draft);
      }} /></> : <>
      {attaching ? <Text accessibilityLiveRegion="polite" style={ui.muted}>Добавляем к автомобилю…</Text> : null}
      <VehicleChooser onChoose={car => {
        if (lock.current) return; lock.current = true; setAttaching(true);
        void (async () => {
          try {
            assertReadyMedia(draft.images);
            await repository.attachIncoming(car.id, draft.images, draft.note, draft.sourceUrl);
            acceptMediaCopies(draft.images);
            clearDraft(draft); router.push({ pathname: '/vehicle/[id]', params: { id: car.id } });
          } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить. Попробуйте снова.'); }
          finally { lock.current = false; setAttaching(false); }
        })();
      }} />
      <ActionButton label="Назад" secondary disabled={attaching} onPress={() => setMode('new')} />
    </>}
  </Page> : null}
    <View style={{ flex: 1, display: choosing ? 'none' : 'flex' }}>
      <VehicleForm key={version} incomingDraft={mode === 'form' ? draft ?? null : null} onShareConsumed={() => { if (draft) clearDraft(draft); }} onShareCancelled={() => setMode('new')}
        onSaved={(id, nextTask) => {
          setVersion(value => value + 1);
          if (nextTask) router.navigate({ pathname: '/task/new', params: { vehicleId: id } });
          else router.navigate({ pathname: '/vehicle/[id]', params: { id } });
        }} />
    </View>
  </View>;
}
