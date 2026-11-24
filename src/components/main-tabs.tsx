import { StackActions, useNavigation } from 'expo-router/react-navigation';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { Icon, type IconName } from './kit';

export const mainTabs = {
  index: { title: 'Главная', icon: 'home-outline' },
  lots: { title: 'Авто', icon: 'car-outline' },
  add: { title: 'Добавить', icon: 'plus-circle-outline' },
  tasks: { title: 'Задачи', icon: 'calendar-check-outline' },
  archive: { title: 'Архив', icon: 'archive-outline' },
} satisfies Record<string, { title: string; icon: IconName }>;

export function DetailTabs({ selected }: { selected: keyof typeof mainTabs }) {
  const { colors } = useTheme();
  const stack = useNavigation();
  const insets = useSafeAreaInsets();
  return <View accessibilityRole="tablist" style={{
    flexDirection: 'row', paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right,
    backgroundColor: colors.background, borderTopWidth: 1, borderTopColor: colors.border,
  }}>
    {Object.entries(mainTabs).map(([screen, tab]) => {
      const active = screen === selected;
      const color = active ? colors.accent : colors.muted;
      return <Pressable key={screen} accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={tab.title}
        onPress={() => {
          const target = stack.getState()?.key;
          if (target && stack.isFocused()) stack.dispatch({ ...StackActions.popTo('(tabs)', { screen }), target });
        }} style={{ flex: 1, minWidth: 0, minHeight: 48, paddingVertical: 4, alignItems: 'center', justifyContent: 'center', gap: 2 }}>
        <Icon name={tab.icon} color={color} />
        <Text style={{ color, fontSize: 10, lineHeight: 14, fontWeight: '600', textAlign: 'center' }}>{tab.title}</Text>
      </Pressable>;
    })}
  </View>;
}
