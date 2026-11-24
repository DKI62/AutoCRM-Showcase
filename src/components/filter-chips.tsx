import { Pressable, ScrollView, Text, View } from 'react-native';
import { useTheme } from '../theme';

export function Chips<T extends string>({ value, choices, onChange }: { value: T | undefined; choices: readonly (readonly [T, string])[]; onChange: (value: T) => void }) {
  const { colors } = useTheme();
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 6, paddingRight: 2 }} style={{ flexGrow: 0 }}>
    {choices.map(([key, label]) => <Pressable key={key} accessibilityLabel={label} accessibilityRole="button" accessibilityState={{ selected: value === key }} onPress={() => onChange(key)}
      style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', flexShrink: 0 }}>
      <View style={{ paddingHorizontal: 11, paddingVertical: 6, borderRadius: 18, backgroundColor: value === key ? colors.primary : colors.surface,
        borderWidth: 1, borderColor: value === key ? colors.primary : colors.controlBorder }}>
        <Text style={{ color: value === key ? colors.onPrimary : colors.text, fontSize: 12, lineHeight: 17, fontWeight: value === key ? '600' : '400' }}>{label}</Text>
      </View>
    </Pressable>)}
  </ScrollView>;
}
