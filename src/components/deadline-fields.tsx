import { DateTimePicker } from '@expo/ui/community/datetime-picker';
import { useState } from 'react';
import { Keyboard, Text, View } from 'react-native';
import { mergeTaskDeadline, quickTaskDeadline, taskDeadlineOnDay } from '../domain/task-deadline';
import { useTheme } from '../theme';
import { ActionButton } from './action-button';
import { Chips } from './filter-chips';

export function DeadlineFields({ value, onChange, onError, disabled = false }: {
  value: Date; onChange: (value: Date) => void; onError: (message: string) => void; disabled?: boolean;
}) {
  const { colors, ui } = useTheme();
  const [picker, setPicker] = useState<'date' | 'time' | null>(null);
  const day = value.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
  const clock = value.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false });
  function select(getDate: () => Date) {
    try { onChange(getDate()); }
    catch (cause) { onError(cause instanceof Error ? cause.message : 'Не удалось выбрать срок.'); }
  }
  function open(mode: 'date' | 'time') { Keyboard.dismiss(); setPicker(mode); }
  return <View style={ui.card}>
    <Text style={ui.heading}>Дата и время</Text>
    <View style={[ui.row, { flexWrap: 'wrap' }]}>
      <ActionButton label={day} secondary compact disabled={disabled} onPress={() => open('date')} />
      <ActionButton label={clock} secondary compact disabled={disabled} onPress={() => open('time')} />
    </View>
    <Chips value={undefined} choices={[[ '2m', '+2 мин' ], [ '0', 'Сегодня' ], [ '1', 'Завтра' ], [ '3', 'Через 3 дня' ]]}
      onChange={preset => {
        if (!disabled) select(() => preset === '2m' ? quickTaskDeadline(Date.now(), preset) : taskDeadlineOnDay(value, Date.now(), Number(preset)));
      }} />
    {picker ? <DateTimePicker value={value} mode={picker} presentation="dialog" is24Hour accentColor={colors.accent}
      positiveButton={{ label: 'Выбрать' }} negativeButton={{ label: 'Отмена' }} onDismiss={() => setPicker(null)}
      onValueChange={(_, selected) => { select(() => mergeTaskDeadline(value, selected, picker)); setPicker(null); }} /> : null}
  </View>;
}
