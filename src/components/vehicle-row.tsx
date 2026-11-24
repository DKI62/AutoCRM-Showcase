import { useNow } from './clock';
import { router } from 'expo-router';
import { Alert, Linking, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { reasonLabels, statusLabels, substatusLabels, vehicleName } from '../domain/models';
import { displayRubles } from '../domain/money';
import { vehicleRowLayout } from '../domain/vehicle-photo-layout';
import type { VehicleSummary } from '../repositories/crm-repository';
import { formatDate, useTheme } from '../theme';
import { Icon, IconButton } from './kit';
import { StoredImage } from './stored-image';

export function VehicleRow({ item, needsReview = false }: { item: VehicleSummary; needsReview?: boolean }) {
  const { colors, ui } = useTheme();
  const now = useNow();
  const { width, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const archived = item.status === 'completed';
  const phone = item.phone.replace(/[^+\d]/g, '');
  const hasCall = !archived && /^\+?\d+$/.test(phone);
  const { stacked, thumbnailWidth } = vehicleRowLayout(Math.min(width, 760) - 32 - insets.left - insets.right, fontScale, hasCall);
  const statusColor = archived ? item.completion_reason === 'bought' ? colors.success : item.completion_reason === 'declined' ? colors.danger : colors.muted : colors.accent;
  return <View style={[ui.card, ui.row, { padding: 0, gap: 0 }]}>
    <Pressable accessibilityRole="button" onPress={() => router.navigate({ pathname: '/vehicle/[id]', params: { id: item.id } })}
      style={({ pressed }) => [ui.row, { flex: 1, minWidth: 0, padding: 9, borderRadius: 10 },
        stacked && { flexDirection: 'column', alignItems: 'flex-start' }, pressed && { backgroundColor: colors.raised }]}>
    {item.image_path ? <StoredImage key={item.image_path} path={item.image_path} thumbnailWidth={thumbnailWidth} /> : <View style={{ width: thumbnailWidth, height: 72, backgroundColor: colors.raised, borderRadius: 9, justifyContent: 'center', alignItems: 'center' }}><Icon name="car-outline" size={25} /></View>}
    <View style={{ flex: stacked ? undefined : 1, minWidth: 0, maxWidth: '100%', gap: 2 }}><Text style={[ui.body, { fontWeight: '700' }]}>{vehicleName(item)}</Text>
      <Text style={ui.muted}>{[item.year, item.mileage && `${item.mileage.replace(/^\d+$/, digits => digits.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f'))} км`, item.lot_type === 'corporate' ? 'Корпоративный' : null].filter(Boolean).join(' · ') || 'Обычный лот'}</Text>
      <Text style={[ui.status, { color: statusColor, maxWidth: '100%' }]}>{item.completion_reason ? reasonLabels[item.completion_reason] : statusLabels[item.status]}{item.substatus ? ` · ${substatusLabels[item.substatus]}` : ''}</Text>
      {needsReview ? <Text style={[ui.muted, { color: colors.warning }]}>Проверить актуальность</Text> : null}
      {!archived && (item.buyout_price || item.listing_price) ? <Text style={[ui.muted, { color: item.buyout_price ? colors.success : colors.text }]}>{item.buyout_price ? `Выкуп: ${displayRubles(item.buyout_price)}` : `Цена: ${displayRubles(item.listing_price)}`}</Text> : null}
      {archived && item.archived_at != null ? <Text style={ui.muted}>{new Date(item.archived_at).toLocaleDateString('ru-RU')}</Text> : null}
      {archived ? item.purchase_price ? <Text style={[ui.muted, { color: colors.success }]}>{displayRubles(item.purchase_price)}</Text> : null
        : item.next_due ? <Text numberOfLines={2} style={{ color: item.next_due < now ? colors.warning : colors.accent, fontSize: 12 }}>{formatDate(item.next_due)} · {item.next_task}</Text>
        : item.note_preview ? <Text numberOfLines={1} style={ui.muted}>{item.note_preview}</Text> : null}
    </View>
    </Pressable>
    {hasCall ? <IconButton name="phone-outline" label={`Позвонить продавцу: ${vehicleName(item)}`} onPress={() => { void Linking.openURL(`tel:${phone}`).catch(() => Alert.alert('Не удалось открыть приложение для звонков.')); }} /> : null}
  </View>;
}
