import { useState } from 'react';
import { Text, View, Pressable } from 'react-native';
import { formatRubles, isAmbiguousRubles, rubleDigits } from '../domain/money';
import { useTheme } from '../theme';
import { Field } from './kit';

export function MoneyField({ label, value, onChangeText, editable = true }: {
  label: string; value: string; onChangeText: (value: string) => void; editable?: boolean;
}) {
  const { colors, ui } = useTheme();
  const [focused, setFocused] = useState(false);
  const [textMode, setTextMode] = useState(() => !!value && rubleDigits(value) === null);
  const formatted = formatRubles(value);
  const preview = focused && formatted !== value;
  const ambiguous = isAmbiguousRubles(value);
  return <View>
    <Field label={label} value={focused ? value : formatted} editable={editable} maxLength={2000}
      labelAction={editable ? <Pressable accessibilityRole="button" accessibilityLabel={textMode ? 'Переключить на ввод суммы' : 'Переключить на текстовую оценку'}
        onPress={() => setTextMode(mode => !mode)} hitSlop={10}>
        <Text style={[ui.label, { color: colors.accent }]}>{textMode ? 'Сумма' : 'Текст'}</Text>
      </Pressable> : null}
      keyboardType={textMode ? 'default' : 'number-pad'} placeholder={textMode ? 'Свободная оценка' : 'Сумма в ₽'}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChangeText={onChangeText} />
    {ambiguous || preview ? <Text style={[ui.muted, { color: ambiguous ? colors.warning : colors.muted }]}>
      {ambiguous ? 'Уточните сумму в рублях' : formatted}
    </Text> : null}
  </View>;
}
