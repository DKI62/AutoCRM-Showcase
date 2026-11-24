import { Clipboard, Linking, Pressable, Text, ToastAndroid, View } from 'react-native';
import { useState } from 'react';
import { vehicleLink } from '../domain/vehicle-links';
import { useTheme } from '../theme';
import { Icon, IconButton } from './kit';

export function VehicleLinkRow({ value }: { value: string }) {
  const { colors, ui } = useTheme();
  const [error, setError] = useState('');
  if (!value.trim()) return null;
  const link = vehicleLink(value);
  return <View style={{ gap: 3 }}>
    <View style={[ui.row, { gap: 2 }]}>
      <Pressable accessibilityRole="link" accessibilityLabel={link ? `${link.label}. ${link.hint}` : 'Некорректная ссылка'} disabled={!link}
        onPress={() => { if (link) { setError(''); void Linking.openURL(link.href).catch(() => setError('Не удалось открыть ссылку. Её можно скопировать.')); } }}
        style={[ui.row, { flex: 1, minHeight: 44, paddingHorizontal: 6 }]}>
        <Icon name="link-variant" size={18} />
        <View style={{ flex: 1, minWidth: 0 }}><Text style={ui.body}>{link?.label ?? 'Некорректная ссылка'}</Text><Text numberOfLines={1} style={ui.muted}>{link?.hint ?? 'Проверьте её в редакторе'}</Text></View>
        {link ? <Icon name="open-in-new" size={16} color={colors.muted} /> : null}
      </Pressable>
      {link ? <IconButton name="content-copy" label={`Копировать ссылку ${link.label}`} onPress={() => {
        try { Clipboard.setString(link.href); ToastAndroid.show('Ссылка скопирована', ToastAndroid.SHORT); }
        catch { setError('Буфер обмена недоступен.'); }
      }} /> : null}
    </View>
    {error ? <Text accessibilityRole="alert" style={ui.error}>{error}</Text> : null}
  </View>;
}
