import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { coverAspectRatio } from '../domain/vehicle-photo-layout';
import { imageFile } from '../services/image-files';
import { useTheme } from '../theme';

export function StoredImage({ path, compact = false, thumbnailWidth }: { path: string; compact?: boolean; thumbnailWidth?: number }) {
  const { colors, ui } = useTheme();
  const [failed, setFailed] = useState(false);
  const [ratio, setRatio] = useState(0);
  let uri: string | null = null;
  try {
    const file = imageFile(path);
    if (file.exists) uri = file.uri;
  } catch { /* An invalid stored path must never escape the managed media directory. */ }
  const style = thumbnailWidth ? [styles.compact, { width: thumbnailWidth, height: thumbnailWidth === 110 ? 132 : 144 }]
    : compact ? styles.compact : [styles.full, { aspectRatio: coverAspectRatio(ratio) }];
  const background = { backgroundColor: colors.surface };
  return uri && !failed ? <Image accessibilityLabel="Изображение автомобиля" source={{ uri }} style={[style, background]}
    resizeMode={compact ? 'cover' : 'center'} resizeMethod="resize"
    onLoad={!compact && !thumbnailWidth ? ({ nativeEvent: { source } }) => { if (source.width && source.height) setRatio(source.width / source.height); } : undefined}
    onError={() => setFailed(true)} /> :
    <View style={[style, background, styles.missing]}><Text style={ui.muted}>{compact || thumbnailWidth ? 'Нет фото' : 'Изображение недоступно. Файл отсутствует или повреждён.'}</Text></View>;
}

const styles = StyleSheet.create({
  full: { width: '100%', maxHeight: 250, borderRadius: 12 },
  compact: { width: 64, height: 64, borderRadius: 12 },
  missing: { alignItems: 'center', justifyContent: 'center', padding: 12 },
});
