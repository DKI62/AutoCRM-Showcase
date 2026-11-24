import { Tabs } from 'expo-router/tabs';
import { router } from 'expo-router';
import { Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, IconButton } from '../../components/kit';
import { useTheme } from '../../theme';
import { mainTabs } from '../../components/main-tabs';

export default function TabLayout() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets(), { width, fontScale } = useWindowDimensions();
  const narrow = width / fontScale < 360;
  const labelLines = fontScale > 1.4 ? 2 : 1;
  return <Tabs backBehavior="initialRoute" screenOptions={{ tabBarHideOnKeyboard: true, tabBarStyle: { backgroundColor: colors.background, borderTopColor: colors.border, height: Math.ceil(Math.max(48, 28 + 14 * fontScale * labelLines + 8) + insets.bottom) },
    tabBarActiveTintColor: colors.accent, tabBarInactiveTintColor: colors.muted, tabBarLabelStyle: { fontSize: 10, lineHeight: 14, fontWeight: '600' },
    tabBarLabel: ({ color, children }) => <Text style={{ color, fontSize: 10, lineHeight: 14, fontWeight: '600', textAlign: 'center', flexShrink: 1 }}>{children}</Text>,
    headerStyle: { backgroundColor: colors.background }, headerTintColor: colors.text, headerShadowVisible: false,
    headerTitleStyle: { fontSize: 17, fontWeight: '700' },
    headerRight: () => <View style={{ flexDirection: 'row' }}>{!narrow ? <IconButton name="magnify" label="Поиск автомобилей" onPress={() => router.navigate('/lots')} /> : null}<IconButton name="bell-outline" label="Журнал уведомлений" onPress={() => router.push('/notifications')} /><IconButton name="cog-outline" label="Настройки" onPress={() => router.push('/settings')} /></View> }}>
    {Object.entries(mainTabs).map(([name, tab]) => <Tabs.Screen key={name} name={name} options={{
      title: tab.title,
      headerTitle: name === 'index' ? () => <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {!narrow ? <Icon name="car-sports" /> : null}<Text style={{ color: colors.text, fontSize: 18, fontWeight: '700' }}>Auto <Text style={{ color: colors.accent }}>CRM</Text></Text>
      </View> : name === 'lots' && !narrow ? 'Автомобили' : name === 'add' && !narrow ? 'Добавить автомобиль' : tab.title,
      tabBarIcon: ({ color }) => <Icon name={tab.icon} color={color} />,
    }} />)}
  </Tabs>;
}
