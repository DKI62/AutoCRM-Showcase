import { Image } from 'expo-image';
import { createVideoPlayer, type VideoThumbnail } from 'expo-video';
import { router } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Attachment } from '../domain/models';
import { useRepository } from '../storage/app-provider';
import { acceptMediaCopies, assertReadyMedia, compensateMediaCopies, imageFile } from '../services/image-files';
import { pickMedia } from '../services/media-picker';
import { formatDate, useTheme } from '../theme';
import { ActionButton } from './action-button';
import { Empty, Icon } from './kit';

const thumbs = new Map<string, VideoThumbnail>();
let thumbnailQueue: Promise<unknown> = Promise.resolve();
function videoThumbnail(path: string): Promise<VideoThumbnail | null> {
  const work = thumbnailQueue.then(async () => {
    const cached = thumbs.get(path); if (cached) return cached;
    const player = createVideoPlayer(null);
    try {
      await player.replaceAsync(imageFile(path).uri);
      const thumbnail = (await player.generateThumbnailsAsync(0, { maxWidth: 240 }))[0];
      if (thumbnail) {
        thumbs.set(path, thumbnail); if (thumbs.size > 24) thumbs.delete(thumbs.keys().next().value!);
        return thumbnail;
      }
      return null;
    } finally { player.release(); }
  });
  thumbnailQueue = work.catch(() => null); return work;
}
export function MediaThumb({ item }: { item: Pick<Attachment, 'relative_path' | 'mime_type'> }) {
  const { colors } = useTheme();
  const [thumbnail, setThumbnail] = useState<VideoThumbnail | null>(null), [failed, setFailed] = useState(false);
  const video = item.mime_type.startsWith('video/');
  useEffect(() => { let active = true; if (video) void videoThumbnail(item.relative_path).then(value => { if (active) setThumbnail(value); }).catch(() => { if (active) setFailed(true); }); return () => { active = false; }; }, [item.relative_path, video]);
  let uri: string | null = null; try { const file = imageFile(item.relative_path); if (file.exists) uri = file.uri; } catch { /* Invalid or missing stored file is displayed as unavailable. */ }
  return <View style={{ height: 120, backgroundColor: colors.raised, borderRadius: 10, overflow: 'hidden', justifyContent: 'center', alignItems: 'center' }}>
    {!failed && (thumbnail || (!video && uri)) ? <Image source={thumbnail || { uri: uri! }} contentFit="cover" style={{ width: '100%', height: '100%' }} onError={() => setFailed(true)} /> : <Icon name={video ? 'video-outline' : 'image-off-outline'} size={32} />}
    {video ? <View style={{ position: 'absolute', right: 8, bottom: 8, backgroundColor: colors.background, borderRadius: 20, padding: 3 }}><Icon name="play-circle-outline" size={28} /></View> : null}
  </View>;
}
export function MediaGallery({ items, vehicleId, header, onChanged }: { items: Attachment[]; vehicleId: string; header: ReactNode; onChanged: () => void }) {
  const { ui } = useTheme();
  const repository = useRepository(), lock = useRef(false); const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const insets = useSafeAreaInsets();
  const bytes = items.reduce((sum, item) => sum + item.byte_size, 0);
  async function add(source: 'gallery' | 'camera' | 'files') {
    if (lock.current) return; lock.current = true; setBusy(true); setError(null);
    let files: Awaited<ReturnType<typeof pickMedia>> = []; let committed = false;
    try { files = await pickMedia(source); if (files.length) { assertReadyMedia(files); await repository.addMedia(vehicleId, files); committed = true; acceptMediaCopies(files); onChanged(); } }
    catch (cause) { if (!committed) await compensateMediaCopies(repository, files); setError(cause instanceof Error ? cause.message : 'Не удалось добавить файлы.'); }
    finally { lock.current = false; setBusy(false); }
  }
  return <FlatList data={items} numColumns={2} columnWrapperStyle={{ gap: 8 }} style={ui.screen} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={[ui.listContent, {
    paddingLeft: 16 + insets.left, paddingRight: 16 + insets.right, paddingBottom: 16,
  }]} keyExtractor={item => item.id} initialNumToRender={6} windowSize={5}
    ListHeaderComponent={<View style={{ gap: 8, marginBottom: 8 }}>{header}
      {items.length ? <Text style={ui.muted}>Файлов: {items.length}{bytes ? ` · ${(bytes / 1048576).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} МБ${items.some(item => !item.byte_size) ? ' (известный размер)' : ''}` : ''}</Text> : null}
      <ActionButton label={busy ? 'Копирование…' : 'Добавить фото и видео'} disabled={busy} onPress={() => { void add('gallery'); }} />
      <View style={ui.row}><View style={{ flex: 1 }}><ActionButton label="Камера" secondary disabled={busy} onPress={() => { void add('camera'); }} /></View><View style={{ flex: 1 }}><ActionButton label="Файлы" secondary disabled={busy} onPress={() => { void add('files'); }} /></View></View>
      {error ? <Text accessibilityRole="alert" style={ui.error}>{error}</Text> : null}
    </View>}
    ListEmptyComponent={<Empty title="Фото и видео пока нет" body="Выберите скриншоты, снимки дефектов или видео осмотра. Размер ограничен свободной памятью устройства." icon="image-plus" />}
    ItemSeparatorComponent={() => <View style={{ height: 8 }} />} renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={item.caption || 'Открыть файл'} onPress={() => router.navigate({ pathname: '/media/[id]', params: { id: item.id, vehicleId } })} style={[ui.card, { flex: 1, minWidth: 0, maxWidth: '50%' }]}>
      <MediaThumb item={item} /><Text numberOfLines={2} style={ui.body}>{item.caption || (item.mime_type.startsWith('video/') ? 'Видео осмотра' : 'Фото автомобиля')}</Text><Text style={ui.muted}>{formatDate(item.created_at)}{item.byte_size ? ` · ${(item.byte_size / 1048576).toFixed(1)} МБ` : ''}</Text>
    </Pressable>} />;
}
