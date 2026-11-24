import { Pressable, Text, View } from 'react-native';
import { useTheme } from '../theme';

export function ActionButton({ label, onPress, disabled = false, secondary = false, compact = false }: {
  label: string; onPress: () => void; disabled?: boolean; secondary?: boolean; compact?: boolean;
}) {
  const { colors, ui, scheme } = useTheme();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={{ minHeight: 44, maxWidth: '100%', justifyContent: 'center', alignSelf: compact ? 'flex-start' : 'stretch', opacity: disabled ? 0.45 : 1 }}>
    {({ pressed }) => <View style={{ minHeight: 38, paddingHorizontal: 14, paddingVertical: 7, justifyContent: 'center', borderRadius: 12,
      backgroundColor: secondary ? pressed ? colors.raised : colors.surface : pressed ? colors.primaryPressed : colors.primary,
      borderWidth: secondary ? 1 : 0, borderColor: scheme === 'light' ? colors.border : colors.controlBorder }}>
      <Text style={[ui.buttonLabel, { color: secondary ? colors.text : colors.onPrimary }]}>{label}</Text>
    </View>}
  </Pressable>;
}
