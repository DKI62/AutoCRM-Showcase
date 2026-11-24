import { NavigationBar } from 'expo-navigation-bar';
import { DarkTheme, DefaultTheme, ThemeProvider, router, useRootNavigationState, type ErrorBoundaryProps } from 'expo-router';
import { Stack } from 'expo-router/stack';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo } from 'react';
import { AppState, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActionButton } from '../components/action-button';
import { IconButton } from '../components/kit';
import { androidNotifications, observeNotifications } from '../services/notifications';
import { AppProvider, useRepository } from '../storage/app-provider';
import { useTheme } from '../theme';
import { reconcileReminders } from '../services/task-reminders';
import { finishMediaCleanup, recoverInterruptedMedia } from '../services/image-files';
import { ClockProvider } from '../components/clock';
import { observeTelegramTaskSync, syncTelegram } from '../services/telegram';
import { diagnostic } from '../services/diagnostics';

void SplashScreen.preventAutoHideAsync();

function NotificationObserver() {
  const repository = useRepository();
  const state = useRootNavigationState();
  useEffect(() => {
    if (!state?.key) return;
    let cleaning = false;
    async function cleanup() {
      if (cleaning) return;
      cleaning = true;
      try {
        await recoverInterruptedMedia(repository).catch(() => undefined);
        await finishMediaCleanup(repository);
      } finally { cleaning = false; }
    }
    function maintain() {
      void reconcileReminders(repository).catch(() => undefined);
      void syncTelegram(repository).then(result => {
        if (result.linked) void reconcileReminders(repository).catch(() => undefined);
      }).catch(() => undefined);
      void cleanup().catch(() => undefined);
    }
    const stopTaskSync = observeTelegramTaskSync(repository, () => AppState.currentState === 'active');
    const stopTaskLog = repository.subscribeTaskChanges?.(operation => diagnostic('task.write', { operation }));
    void maintain();
    const timer = setInterval(() => { if (AppState.currentState === 'active') void maintain(); }, 60000);
    const appState = AppState.addEventListener('change', value => {
      if (value === 'active') { diagnostic('session.active'); void maintain(); }
      else if (value === 'background') diagnostic('session.background');
    });
    const unobserve = observeNotifications((id, taskId, review) => {
      if (taskId) router.navigate({ pathname: '/task/[id]', params: { id: taskId } });
      else if (id) router.navigate({ pathname: '/vehicle/[id]', params: { id } });
      else if (review === 'archive') router.navigate('/archive?review=due');
      else if (review === 'cold') router.navigate('/');
      else router.navigate('/notifications');
    }, (id, event, taskId, vehicleId, due) => {
      diagnostic(event === 'opened' ? 'alarm.opened' : 'alarm.received', due === undefined ? {} : { due });
      void repository.recordNotification(androidNotifications.provider, id, event, taskId, vehicleId).catch(() => undefined);
    });
    return () => { stopTaskLog?.(); stopTaskSync(); clearInterval(timer); appState.remove(); unobserve(); };
  }, [repository, state?.key]);
  return null;
}

function RouteHeader({ title, back }: { title: string; back?: (() => void) | undefined }) {
  const { colors, ui } = useTheme();
  const insets = useSafeAreaInsets();
  return <View style={[ui.row, { minHeight: insets.top + 52, paddingTop: insets.top, paddingLeft: insets.left + 8, paddingRight: insets.right + 16, backgroundColor: colors.background }]}>
    {back ? <IconButton name="arrow-left" label="Назад" onPress={back} /> : null}
    <Text accessibilityRole="header" style={[ui.heading, { flex: 1 }]}>{title}</Text>
  </View>;
}

function AppNavigation() {
  const { colors, scheme } = useTheme();
  const navigationTheme = useMemo(() => {
    const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
    return { ...base, colors: {
      primary: colors.accent, background: colors.background, card: colors.surface,
      text: colors.text, border: colors.border, notification: colors.danger,
    } };
  }, [colors, scheme]);
  const foreground = scheme === 'dark' ? 'light' : 'dark';
  return <ThemeProvider value={navigationTheme}>
    <View style={{ flex: 1, backgroundColor: colors.background }} onLayout={SplashScreen.hide}>
      <StatusBar style={foreground} />
      <NavigationBar style={foreground} />
      <Stack screenOptions={{
        // A custom React header keeps ScreenStackHeaderConfig hidden. Android then
        // returns before canNavigateBack during a detached Fabric transition.
        header: ({ options, navigation, back }) => <RouteHeader title={options.title ?? 'Auto CRM'}
          back={back ? () => { if (navigation.isFocused() && navigation.canGoBack()) navigation.goBack(); } : undefined} />,
        contentStyle: { backgroundColor: colors.background },
      }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="vehicle/[id]" options={{ title: 'Автомобиль' }} />
        <Stack.Screen name="vehicle/edit" options={{ title: 'Редактировать автомобиль' }} />
        <Stack.Screen name="task/new" options={{ title: 'Новая задача' }} />
        <Stack.Screen name="task/[id]" options={{ title: 'Задача' }} />
        <Stack.Screen name="settings" options={{ title: 'Настройки' }} />
        <Stack.Screen name="notifications" options={{ title: 'Уведомления' }} />
        <Stack.Screen name="media/[id]" options={{ headerShown: false }} />
      </Stack>
      <NotificationObserver />
    </View>
  </ThemeProvider>;
}

export default function RootLayout() {
  return <SafeAreaProvider><ClockProvider><AppProvider><AppNavigation /></AppProvider></ClockProvider></SafeAreaProvider>;
}

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const { ui } = useTheme();
  return <View style={[ui.screen, { padding: 24, justifyContent: 'center', gap: 20 }]}>
    <Text style={ui.heading}>Не удалось открыть экран</Text><Text style={ui.error}>{error.message}</Text>
    <ActionButton label="Повторить" onPress={retry} />
  </View>;
}
