import * as Notifications from 'expo-notifications';
import { File, Paths } from 'expo-file-system';
import { writeAsStringAsync } from 'expo-file-system/legacy';
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import { useState } from 'react';
import { Alert, Clipboard, Linking, Text, View } from 'react-native';
import { exactAlarmStatus, openExactAlarmSettings } from '../services/alarm-access';
import { clearDiagnostics, diagnosticDevice, diagnosticLog } from '../services/diagnostics';
import { useTheme } from '../theme';
import { ActionButton } from './action-button';
import { Icon } from './kit';

export function BetaDiagnostics() {
  const { ui } = useTheme();
  const [output, setOutput] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function summary() {
    const [permission, exact, channels, scheduled] = await Promise.all([
      Notifications.getPermissionsAsync(), exactAlarmStatus(),
      Notifications.getNotificationChannelsAsync(), Notifications.getAllScheduledNotificationsAsync(),
    ]);
    const importance = channels.filter(channel => /^(?:reminders-v1|reminders-v2-s[01]-v[01])$/.test(channel.id)).map(channel => `${channel.id} = ${channel.importance}`).join(', ');
    return `${diagnosticDevice()}\n${new Date().toISOString()}\nУведомления: ${permission.granted ? 'разрешены' : 'запрещены'}\nТочные будильники: ${exact === null ? 'статус недоступен в этой сборке' : exact ? 'разрешены' : 'запрещены'}\nЗапросов в Expo: ${scheduled.length}\nКаналы: ${importance || 'не созданы'}`;
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await action(); }
    catch { setMessage('Не удалось выполнить диагностическую операцию.'); }
    finally { setBusy(false); }
  }
  return <View style={ui.card}>
    <View style={ui.row}><Icon name="code-tags" size={18} /><Text style={ui.heading}>Разработчику</Text></View>
    <ActionButton secondary disabled={busy} label="Состояние и последние события" onPress={() => { void run(async () => {
      setOutput(`${await summary()}\n\n${(await diagnosticLog()).split('\n').slice(-20).join('\n')}`);
    }); }} />
    <ActionButton secondary disabled={busy} label="Ошибки" onPress={() => { void run(async () => {
      setOutput((await diagnosticLog()).split('\n').filter(line => line.includes('.error"')).slice(-20).join('\n') || 'Ошибок в журнале нет.');
    }); }} />
    <ActionButton secondary disabled={busy} label="Настройки уведомлений Android" onPress={() => { void run(() => Linking.openSettings()); }} />
    <ActionButton secondary disabled={busy} label="Точные будильники Android" onPress={() => { void run(async () => {
      if (await exactAlarmStatus() === null) setMessage('Для проверки доступа к точным будильникам нужна новая APK.');
      else await openExactAlarmSettings();
    }); }} />
    <Text style={ui.muted}>Если доступ закрыт, разрешите «Будильники и напоминания». Без доступа Android может задерживать доставку.</Text>
    <ActionButton secondary disabled={busy} label="Скопировать сводку" onPress={() => { void run(async () => {
      Clipboard.setString(await summary()); setMessage('Сводка скопирована.');
    }); }} />
    <ActionButton secondary disabled={busy} label="Поделиться отчётом" onPress={() => { void run(async () => {
      if (!(await isAvailableAsync())) throw new Error();
      const file = new File(Paths.cache, 'auto-crm-diagnostics.txt');
      await writeAsStringAsync(file.uri, `${await summary()}\n\nJSONL\n${await diagnosticLog()}\n`);
      await shareAsync(file.uri, { mimeType: 'text/plain', dialogTitle: 'Диагностика Auto CRM' });
    }); }} />
    <ActionButton secondary disabled={busy} label="Очистить журнал диагностики" onPress={() => {
      Alert.alert('Очистить журнал?', 'Удаляются только технические события.', [
        { text: 'Отмена', style: 'cancel' },
        { text: 'Очистить', style: 'destructive', onPress: () => { void run(async () => {
          await clearDiagnostics();
          const report = new File(Paths.cache, 'auto-crm-diagnostics.txt');
          if (report.exists) report.delete();
          setOutput(''); setMessage('Журнал очищен.');
        }); } },
      ]);
    }} />
    {message ? <Text accessibilityRole="alert" style={ui.muted}>{message}</Text> : null}
    {output ? <Text selectable style={ui.muted}>{output}</Text> : null}
  </View>;
}
