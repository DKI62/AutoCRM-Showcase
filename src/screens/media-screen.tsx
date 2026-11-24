import { useEvent } from 'expo';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useNavigation } from 'expo-router/react-navigation';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Attachment } from '../domain/models';
import { ActionButton } from '../components/action-button';
import { ConfirmDialog } from '../components/confirm-dialog';
import { ZoomPhoto } from '../components/zoom-photo';
import { useDiscardDraft } from '../components/discard-draft';
import { Field, IconButton, LoadState, Page, useLoad } from '../components/kit';
import { useRepository } from '../storage/app-provider';
import { finishMediaCleanup, imageFile } from '../services/image-files';
import { formatDate, useTheme } from '../theme';

function Video({ uri, width, height }: { uri: string; width: number; height: number }) {
  const { ui } = useTheme();
  const player = useVideoPlayer(uri); const { status, error } = useEvent(player, 'statusChange', { status: player.status });
  return <View style={{ width, height, justifyContent: 'center' }}><VideoView player={player} nativeControls contentFit="contain" style={{ width, height }} />
    {status === 'error' ? <Text accessibilityRole="alert" style={[ui.error, { position: 'absolute', padding: 16 }]}>Видео не воспроизводится: {error?.message || 'формат не поддерживается устройством'}. Исходный файл сохранён.</Text> : null}</View>;
}
function MediaFrame({ item, width, height, active, onZoom }: { item: Attachment; width: number; height: number; active: boolean; onZoom: (zoomed: boolean) => void }) {
  const { ui } = useTheme();
  const [attempt, setAttempt] = useState(0);
  const retry = () => setAttempt(count => count + 1);
  let uri: string | null = null;
  try { const file = imageFile(item.relative_path); if (file.exists) uri = file.uri; } catch { /* Invalid stored path cannot access outside media directory. */ }
  if (!uri) return <View style={{ width, height, justifyContent: 'center', padding: 24, gap: 8 }}>
    {active ? <><Text accessibilityRole="alert" style={ui.error}>Файл отсутствует или недоступен. Если копия была удалена, восстановите её из резервной копии.</Text>
      <ActionButton label="Проверить снова" secondary onPress={retry} /></> : null}
  </View>;
  if (!active) return item.mime_type.startsWith('image/') ? <Image source={{ uri }} contentFit="contain" cachePolicy="memory" style={{ width, height }} /> : <View style={{ width, height }} />;
  return item.mime_type.startsWith('video/') ? <Video uri={uri} width={width} height={height} /> : <ZoomPhoto key={`${uri}:${attempt}`} uri={uri} width={width} height={height} onZoom={onZoom} onRetry={retry} />;
}
export function MediaScreen() {
  const { colors, ui } = useTheme();
  const { id, vehicleId } = useLocalSearchParams<{ id: string; vehicleId: string }>(); const repository = useRepository();
  const load = useLoad(useCallback(() => repository.getVehicle(vehicleId), [repository, vehicleId]));
  const [index, setIndex] = useState<number | null>(null), [captions, setCaptions] = useState<Record<string, string>>({}), [editing, setEditing] = useState(false), [zoomed, setZoomed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null); const lock = useRef(false), list = useRef<FlatList<Attachment>>(null);
  const [reload, setReload] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false), [notice, setNotice] = useState('');
  const items = load.data?.attachments ?? []; const first = Math.max(0, items.findIndex(item => item.id === id)); const active = Math.min(index ?? first, Math.max(0, items.length - 1)); const selected = items[active];
  const caption = selected ? captions[selected.id] ?? null : null;
  const navigation = useNavigation();
  const discardDraftDialog = useDiscardDraft(Object.keys(captions).length > 0, busy, () => lock.current);
  function clearCaption(key: string) { setCaptions(previous => { const next = { ...previous }; delete next[key]; return next; }); }
  function go(next: number) { setZoomed(false); list.current?.scrollToIndex({ index: next, animated: true }); setIndex(next); }
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null);
  const { width, height } = frame ?? { width: 0, height: 0 };
  function close() { if (navigation.isFocused() && router.canGoBack()) router.back(); else if (navigation.isFocused()) router.replace({ pathname: '/vehicle/[id]', params: { id: vehicleId } }); }
  async function mutate(action: () => Promise<void>, after?: () => void) {
    if (lock.current) return; lock.current = true; setBusy(true); setError(null);
    try { await action(); after?.(); await load.refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Операция не выполнена.'); }
    finally { lock.current = false; setBusy(false); }
  }
  if (!selected) return <SafeAreaView style={ui.screen}><Page><LoadState loading={load.loading} error={load.error} retry={() => { void load.refresh(); }} />
    {!load.loading && !load.error ? <Text style={ui.muted}>{notice || 'Файл не найден.'}</Text> : null}<ActionButton label="К автомобилю" onPress={close} /></Page></SafeAreaView>;
  return <SafeAreaView style={ui.screen}>
      {discardDraftDialog}
      <View style={[ui.row, { justifyContent: 'space-between', paddingHorizontal: 8 }]}>
        <IconButton name="close" label="Закрыть просмотр" onPress={close} />
        <Text style={ui.heading}>{active + 1} / {items.length}</Text>
        <IconButton name="dots-vertical" label="Подпись, обложка и удаление" onPress={() => setEditing(true)} />
      </View>
      <View style={{ flex: 1 }} onLayout={event => {
        const { width: nextWidth, height: nextHeight } = event.nativeEvent.layout;
        if (nextWidth > 1 && nextHeight > 1) {
          if (nextWidth !== width) setZoomed(false);
          setFrame(previous => previous?.width === nextWidth && previous.height === nextHeight ? previous : { width: nextWidth, height: nextHeight });
        }
      }}>
        {frame ? <FlatList ref={list} key={`${width}-${items.length}`} data={items} horizontal pagingEnabled scrollEnabled={!zoomed}
          initialScrollIndex={active} getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          showsHorizontalScrollIndicator={false} keyExtractor={item => item.id} initialNumToRender={1} maxToRenderPerBatch={2} windowSize={3}
          onMomentumScrollEnd={event => { setZoomed(false); setIndex(Math.max(0, Math.min(items.length - 1, Math.round(event.nativeEvent.contentOffset.x / width)))); }}
          renderItem={({ item, index: i }) => <MediaFrame key={i === active ? reload : 0} item={item} width={width} height={height} active={i === active} onZoom={setZoomed} />} />
          : <ActivityIndicator color={colors.accent} style={{ flex: 1 }} />}
      </View>
      <View style={[ui.row, { justifyContent: 'space-between' }]}><IconButton name="chevron-left" label="Предыдущий файл" disabled={active === 0} onPress={() => go(active - 1)} /><Text numberOfLines={2} style={[ui.muted, { flex: 1, textAlign: 'center' }]}>{selected.caption || formatDate(selected.created_at)}</Text><IconButton name="chevron-right" label="Следующий файл" disabled={active === items.length - 1} onPress={() => go(active + 1)} /></View>
      {notice ? <Text accessibilityLiveRegion="polite" style={[ui.muted, { paddingHorizontal: 12 }]}>{notice}</Text> : null}
      <ConfirmDialog title={confirmDelete ? 'Удалить этот файл?' : 'Файл'} visible={editing} busy={busy} onClose={() => { if (confirmDelete) setConfirmDelete(false); else setEditing(false); }}>
      {!confirmDelete ? <>
      <Field label="Подпись к файлу" value={caption ?? selected.caption} onChangeText={value => setCaptions(previous => ({ ...previous, [selected.id]: value }))} multiline editable={!busy} maxLength={10000} />
      <ActionButton label="Сохранить подпись" secondary disabled={busy || caption === null} onPress={() => { void mutate(() => repository.updateAttachmentCaption(selected.id, caption ?? selected.caption), () => clearCaption(selected.id)); }} />
      {selected.mime_type.startsWith('image/') ? <ActionButton label={load.data?.vehicle.cover_id === selected.id ? 'Это главная обложка' : 'Сделать обложкой'} disabled={busy || load.data?.vehicle.cover_id === selected.id} onPress={() => { void mutate(() => repository.setCover(vehicleId, selected.id)); }} /> : null}
      {selected.mime_type.startsWith('image/') ? <ActionButton label="Перезагрузить фото" secondary disabled={busy} onPress={() => {
        setEditing(false); setZoomed(false); setReload(value => value + 1);
      }} /> : null}
      <ActionButton label="Удалить файл" secondary disabled={busy} onPress={() => setConfirmDelete(true)} />
      </> : <>
        <Text style={ui.muted}>Будет удалена копия Auto CRM. Оригинал останется в галерее.</Text>
        <ActionButton label="Удалить копию" disabled={busy} onPress={() => { void mutate(async () => {
          await repository.removeMedia(vehicleId, selected.id);
          await finishMediaCleanup(repository).catch(() => undefined);
          const stillQueued = await repository.cleanupFiles().then(files => files.some(file => file.relative_path === selected.relative_path)).catch(() => true);
          setNotice(stillQueued ? 'Запись удалена. Очистка файлов ещё в очереди.' : 'Копия удалена из CRM.');
        }, () => {
          clearCaption(selected.id); setIndex(Math.max(0, active - 1)); setZoomed(false); setConfirmDelete(false); setEditing(false);
        }); }} />
      </>}
      {error ? <Text accessibilityRole="alert" style={ui.error}>{error}</Text> : null}
      </ConfirmDialog>
  </SafeAreaView>;
}
