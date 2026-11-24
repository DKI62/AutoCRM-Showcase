import { randomUUID } from 'expo-crypto';
import { useCallback, useRef, useState } from 'react';
import Constants from 'expo-constants';
import { Alert, Linking, Platform, Switch, Text, View } from 'react-native';
import { ActionButton } from '../components/action-button';
import { Chips, Field, Icon, LoadState, Page, useLoad } from '../components/kit';
import { readBackup, exportBackup, restoreBackup } from '../services/backup';
import { androidNotifications, ensureNotificationChannel } from '../services/notifications';
import { reconcileReminders } from '../services/task-reminders';
import { decideTelegramPairing, disconnectTelegram, pairTelegram, syncTelegram, telegramStatus, testTelegram } from '../services/telegram';
import { useRepository } from '../storage/app-provider';
import { formatDate, useTheme } from '../theme';
import { reviewChoices, reviewDays, reviewSetting, type ReviewKind } from '../domain/vehicle-review';
import { finishMediaCleanup } from '../services/image-files';
import { useDiscardDraft } from '../components/discard-draft';
import { BetaDiagnostics } from '../components/beta-diagnostics';

export function SettingsScreen() {
  const { colors, ui, mode, scheme, changeMode } = useTheme();
  const repository = useRepository(); const [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null), [error, setError] = useState<string | null>(null); const lock = useRef(false);
  const [endpoint, setEndpoint] = useState(''), [quietStart, setQuietStart] = useState<string | null>(null), [quietEnd, setQuietEnd] = useState<string | null>(null), [timezone, setTimezone] = useState<string | null>(null);
  const [morning, setMorning] = useState<string | null>(null), [evening, setEvening] = useState<string | null>(null);
  const [overdue, setOverdue] = useState<boolean | null>(null);
  const [pairCode, setPairCode] = useState('');
  const [section, setSection] = useState<'reminders' | 'appearance' | 'backup' | 'telegram' | 'about' | 'developer'>('reminders');
  const load = useLoad(useCallback(async () => ({
    sound: (await repository.getSetting('notification_sound')) ?? 'on', vibration: (await repository.getSetting('notification_vibration')) ?? 'on',
    telegram: await telegramStatus(repository), quietStart: (await repository.getSetting('telegram_quiet_start')) ?? '22',
    quietEnd: (await repository.getSetting('telegram_quiet_end')) ?? '8', timezone: (await repository.getSetting('telegram_timezone')) ?? 'Europe/Moscow',
    morning: (await repository.getSetting('telegram_morning') ?? '9').replace('-1', ''),
    evening: (await repository.getSetting('telegram_evening') ?? '19').replace('-1', ''),
    overdue: (await repository.getSetting('telegram_overdue')) !== 'off',
    cold: reviewDays('cold', await repository.getSetting(reviewSetting.cold)), archive: reviewDays('archive', await repository.getSetting(reviewSetting.archive)),
    pendingFiles: (await repository.cleanupFiles()).length,
  }), [repository]));
  const telegramDirty = load.data?.telegram.configured
    ? (timezone !== null && timezone !== load.data.timezone) || (quietStart !== null && quietStart !== load.data.quietStart) || (quietEnd !== null && quietEnd !== load.data.quietEnd)
      || (morning !== null && morning !== load.data.morning) || (evening !== null && evening !== load.data.evening) || (overdue !== null && overdue !== load.data.overdue)
    : !!endpoint.trim();
  const discardDraftDialog = useDiscardDraft(telegramDirty, busy, () => lock.current);
  async function run(action: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(true); setMessage(null); setError(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось выполнить операцию.'); }
    finally { lock.current = false; setBusy(false); }
  }
  function preference(key: 'notification_sound' | 'notification_vibration', value: string) {
    void run(async () => {
      if (value === (key === 'notification_sound' ? load.data?.sound : load.data?.vibration)) return;
      await repository.rescheduleAllReminders({ key, value });
      void reconcileReminders(repository).catch(() => undefined);
      await load.refresh();
      setMessage('Настройка сохранена. Android позволяет дополнительно изменить канал в системных настройках.');
    });
  }
  function setReview(kind: ReviewKind, value: string) {
    void run(async () => {
      await repository.setSetting(reviewSetting[kind], value);
      void reconcileReminders(repository).catch(() => undefined);
      repository.notifyChanges();
      setMessage('Интервал проверки сохранён.');
    });
  }
  const notificationPreferences = load.data;
  const candidate = load.data?.telegram.pairingCandidate;
  return <Page avoidAndroidKeyboard>
    {discardDraftDialog}
    <Chips value={section} choices={[[ 'reminders', 'Уведомления' ], [ 'appearance', 'Оформление' ], [ 'telegram', 'Telegram' ], [ 'backup', 'Контроль и хранение' ], [ 'about', 'О приложении' ], [ 'developer', 'Разработчику' ]]}
      onChange={value => { if (!busy) { setSection(value); setMessage(null); setError(null); } }} />
    <LoadState loading={load.loading} error={load.error} retry={() => { void load.refresh(); }} />
    {section === 'developer' ? <BetaDiagnostics /> : null}
    {section === 'appearance' ? <View style={ui.card}>
      <View style={ui.row}><Icon name="theme-light-dark" /><Text style={ui.heading}>Оформление</Text></View>
      <Chips value={mode} choices={[[ 'light', 'Светлая' ], [ 'dark', 'Тёмная' ], [ 'system', 'Системная' ]]}
        onChange={value => { if (value !== mode) void run(() => changeMode(value)); }} />
      {mode === 'system' ? <Text style={ui.muted}>Сейчас используется {scheme === 'dark' ? 'тёмная' : 'светлая'} тема Android.</Text> : null}
    </View> : null}
    {section === 'reminders' ? <View style={ui.card}><View style={ui.row}><Icon name="bell-outline" /><Text style={ui.heading}>Уведомления</Text></View>
      {load.data ? <><Text style={ui.label}>Звук</Text><Chips value={load.data.sound} choices={[[ 'on', 'Включён' ], [ 'off', 'Без звука' ]]} onChange={value => preference('notification_sound', value)} />
        <Text style={ui.label}>Вибрация</Text><Chips value={load.data.vibration} choices={[[ 'on', 'Включена' ], [ 'off', 'Выключена' ]]} onChange={value => preference('notification_vibration', value)} /></> : null}
      <ActionButton label="Разрешить уведомления" secondary disabled={busy} onPress={() => { void run(async () => { const granted = await androidNotifications.requestPermission(); void reconcileReminders(repository).catch(() => undefined); setMessage(granted ? 'Уведомления разрешены.' : 'Разрешение закрыто. Откройте системные настройки приложения.'); }); }} />
      <ActionButton label="Настройки Android" secondary disabled={busy} onPress={() => { void Linking.openSettings(); }} />
      {Platform.OS === 'android' && Number(Platform.Version) >= 26 && notificationPreferences ? <>
        <ActionButton label="Звук и вибрация канала Android" secondary disabled={busy} onPress={() => { void run(async () => {
          const packageName = Constants.expoConfig?.android?.package;
          if (!packageName) { await Linking.openSettings(); return; }
          const channel = await ensureNotificationChannel(notificationPreferences.sound !== 'off', notificationPreferences.vibration !== 'off');
          await Linking.sendIntent('android.settings.CHANNEL_NOTIFICATION_SETTINGS', [
            { key: 'android.provider.extra.APP_PACKAGE', value: packageName },
            { key: 'android.provider.extra.CHANNEL_ID', value: channel },
          ]).catch(() => Linking.openSettings());
        }); }} />
        <Text style={ui.muted}>Выберите звук и вибрацию текущего канала в Android. Для слышимого сигнала включите звук выше.</Text>
      </> : null}
      <ActionButton label="Проверить сигнал через 10 секунд" secondary disabled={busy} onPress={() => { void run(async () => {
        if (!(await androidNotifications.requestPermission())) throw new Error('Разрешите уведомления в настройках Android.');
        const id = randomUUID(); await androidNotifications.schedule({ id, title: 'Auto CRM', body: 'Проверка локального напоминания.', at: new Date(Date.now() + 10000), sound: load.data?.sound !== 'off', vibration: load.data?.vibration !== 'off' });
        await repository.recordNotification('android', id, 'scheduled'); setMessage('Сигнал запланирован примерно через 10 секунд. Можно закрыть приложение.');
      }); }} />
      <Text style={ui.muted}>Принудительная остановка через настройки Android блокирует уведомления до следующего запуска. Смахивание приложения и режим энергосбережения зависят от настроек Samsung.</Text>
    </View> : null}
    {section === 'backup' ? <><View style={ui.card}><Text style={ui.heading}>Контроль актуальности автомобилей</Text>
      <Text style={ui.muted}>Холодные карточки</Text>
      <Chips value={String(load.data?.cold ?? 7)} choices={reviewChoices.cold.map(days => [String(days), days ? `${days} дн.` : 'Выключено'] as const)} onChange={value => setReview('cold', value)} />
      <Text style={ui.muted}>Старые карточки в архиве</Text>
      <Chips value={String(load.data?.archive ?? 14)} choices={reviewChoices.archive.map(days => [String(days), days ? `${days} дн.` : 'Никогда'] as const)} onChange={value => setReview('archive', value)} />
      <Text style={ui.muted}>Выполненные задачи можно убрать в меню раздела «Выполнено».</Text>
      {load.data?.pendingFiles ? <ActionButton label={`Повторить очистку файлов · ${load.data.pendingFiles}`} secondary disabled={busy} onPress={() => { void run(async () => {
        const remaining = await finishMediaCleanup(repository); await load.refresh(); setMessage(remaining ? `Файлов в очереди: ${remaining}.` : 'Очередь очистки завершена.');
      }); }} /> : null}
    </View><View style={ui.card}><View style={ui.row}><Icon name="database-outline" /><Text style={ui.heading}>Резервная копия</Text></View>
      <Text style={ui.muted}>Экспортирует карточки, заметки, историю, задачи и все фото/видео в выбранную папку. Храните её в надёжном месте: данные не зашифрованы. Для локальной копии выберите память телефона, а не облачного провайдера.</Text>
      <ActionButton label="Сохранить полную копию в папку" disabled={busy} onPress={() => { void run(async () => { const path = await exportBackup(repository, setMessage); setMessage(`Копия проверена и сохранена: ${path}`); }); }} />
      <ActionButton label="Восстановить из папки" secondary disabled={busy} onPress={() => { void run(async () => {
        const backup = await readBackup();
        const confirmed = await new Promise<boolean>(resolve => Alert.alert('Добавить данные из копии?', `Карточек в копии: ${backup.manifest.tables.lots!.length}. Существующие UUID и их данные останутся без изменений. Новые карточки будут добавлены вместе со всеми файлами.`, [ { text: 'Отмена', style: 'cancel', onPress: () => resolve(false) }, { text: 'Восстановить', onPress: () => resolve(true) } ], { cancelable: false }));
        if (!confirmed) return;
        const count = await restoreBackup(repository, backup, setMessage); void reconcileReminders(repository).catch(() => undefined); setMessage(`Восстановлено новых карточек: ${count}. Существующие карточки сохранены.`);
      }); }} />
    </View></> : null}
    {section === 'telegram' ? <View style={ui.card}><View style={ui.row}><Icon name="send-outline" /><Text style={ui.heading}>Telegram</Text></View>
      <Text style={ui.body}>{load.data?.telegram.pendingRevocation ? 'Отключён на телефоне · ожидается отзыв на сервере' : load.data?.telegram.linked ? 'Подключён' : load.data?.telegram.configured ? 'Ожидается подтверждение привязки' : 'Не подключён'}</Text>
      {load.data?.telegram.lastSync ? <Text style={ui.muted}>Последняя успешная синхронизация: {formatDate(load.data.telegram.lastSync)}</Text> : null}
      {load.data?.telegram.pending ? <Text style={ui.muted}>Есть изменения, ожидающие отправки.</Text> : null}
      <Text style={ui.muted}>Сервер получает данные задач, короткие названия и стадии автомобилей, сроки проверок и итоги звонков, которые вы сами отправили боту. Локальные напоминания работают и без Telegram.</Text>
      {load.data?.telegram.configured ? <>
        <Text selectable style={ui.muted}>{load.data.telegram.origin}</Text>
        <ActionButton label="Проверить привязку и синхронизировать" secondary disabled={busy || load.data.telegram.pendingRevocation} onPress={() => { void run(async () => {
          const result = await syncTelegram(repository, true).finally(load.refresh); void reconcileReminders(repository).catch(() => undefined);
          setMessage(result.linked ? `Сервер подтвердил записей: ${result.uploaded}. Конфликтов в этом обмене: ${result.conflicts}.` : 'Если вы уже нажали Start, проверьте аккаунт ниже и введите код из своего чата с ботом.');
        }); }} />
        {load.data.telegram.pairingState === 'expired' || load.data.telegram.pairingState === 'rejected' ?
          <Text style={ui.muted}>Ссылка больше не действует. Отмените запрос и создайте новую.</Text> : null}
        {candidate ? <View style={ui.card}>
          <Text style={ui.heading}>Подтвердите Telegram-аккаунт</Text>
          <Text style={ui.body}>{[candidate.displayName, candidate.username && `@${candidate.username}`].filter(Boolean).join(' · ') || 'Имя недоступно'}</Text>
          <Text style={ui.muted}>Сверьте аккаунт. Введите код, полученный в вашем чате с ботом. Если аккаунт чужой, отклоните запрос.</Text>
          <Field label="Код из чата с ботом" value={pairCode} onChangeText={setPairCode} autoCapitalize="none" autoCorrect={false} secureTextEntry maxLength={12} editable={!busy} />
          <ActionButton label="Подтвердить" disabled={busy || pairCode.trim().length !== 12} onPress={() => { void run(async () => {
            try {
              await decideTelegramPairing(candidate.requestId, pairCode.trim().toLowerCase());
              setPairCode('');
              await syncTelegram(repository, true);
              setMessage('Аккаунт подтверждён. Telegram подключён.');
            } finally { await load.refresh(); }
          }); }} />
          <ActionButton label="Отклонить" secondary disabled={busy} onPress={() => { void run(async () => {
            try {
              await decideTelegramPairing(candidate.requestId, null);
              setPairCode('');
              await disconnectTelegram(repository);
              setEndpoint(load.data!.telegram.origin);
              setMessage('Запрос отклонён. Можно создать новую ссылку.');
            } finally { await load.refresh(); }
          }); }} />
        </View> : null}
        <ActionButton label="Отправить тест в Telegram" secondary disabled={busy || !load.data.telegram.linked || load.data.telegram.pendingRevocation} onPress={() => {
          void run(async () => { await testTelegram(repository); setMessage('Telegram принял тестовое сообщение. Проверьте чат с ботом.'); });
        }} />
        <Field label="Часовой пояс Telegram" value={timezone ?? load.data.timezone} onChangeText={setTimezone} editable={!busy} placeholder="Europe/Moscow" />
        <View style={ui.row}><View style={{ flex: 1 }}><Field label="Тихие часы: с (0–23)" value={quietStart ?? load.data.quietStart} onChangeText={setQuietStart} keyboardType="number-pad" maxLength={2} editable={!busy} /></View><View style={{ flex: 1 }}><Field label="До (0–23)" value={quietEnd ?? load.data.quietEnd} onChangeText={setQuietEnd} keyboardType="number-pad" maxLength={2} editable={!busy} /></View></View>
        <Text style={ui.muted}>Час сводки от 0 до 23. Пустое поле отключает сводку.</Text>
        <View style={ui.row}>
          <View style={{ flex: 1 }}><Field label="Утренняя сводка" value={morning ?? load.data.morning} onChangeText={setMorning} keyboardType="number-pad" maxLength={2} editable={!busy} /></View>
          <View style={{ flex: 1 }}><Field label="Вечерняя сводка" value={evening ?? load.data.evening} onChangeText={setEvening} keyboardType="number-pad" maxLength={2} editable={!busy} /></View>
        </View>
        <View style={ui.row}><Text style={[ui.body, { flex: 1 }]}>Одно напоминание о просрочке</Text>
          <Switch accessibilityLabel="Напоминание о просрочке" value={overdue ?? load.data.overdue} disabled={busy}
            trackColor={scheme === 'light' ? { false: colors.controlBorder, true: colors.primary } : undefined}
            onValueChange={setOverdue} /></View>
        <ActionButton label="Сохранить настройки Telegram" secondary disabled={busy || load.data.telegram.pendingRevocation} onPress={() => { void run(async () => {
          const startText = quietStart ?? load.data!.quietStart, endText = quietEnd ?? load.data!.quietEnd, zone = (timezone ?? load.data!.timezone).trim();
          const start = Number(startText), end = Number(endText);
          if (!/^\d{1,2}$/.test(startText) || !/^\d{1,2}$/.test(endText) || start > 23 || end > 23) throw new Error('Часы должны быть от 0 до 23.');
          const morningHour = morning ?? load.data!.morning, eveningHour = evening ?? load.data!.evening;
          if ([morningHour, eveningHour].some(hour => hour !== '' && (!/^\d{1,2}$/.test(hour) || Number(hour) > 23))) throw new Error('Укажите час сводки от 0 до 23.');
          new Intl.DateTimeFormat('ru-RU', { timeZone: zone }).format(new Date());
          await repository.setSettings({ telegram_quiet_start: String(start), telegram_quiet_end: String(end), telegram_timezone: zone,
            telegram_morning: morningHour === '' ? '-1' : String(Number(morningHour)), telegram_evening: eveningHour === '' ? '-1' : String(Number(eveningHour)),
            telegram_overdue: (overdue ?? load.data!.overdue) ? 'on' : 'off' });
          setQuietStart(null); setQuietEnd(null); setTimezone(null); setMorning(null); setEvening(null); setOverdue(null);
          const result = await syncTelegram(repository, true).finally(load.refresh);
          setMessage(result.linked ? 'Настройки сохранены на телефоне и сервере. Одинаковые часы отключают тихий период.' : 'Настройки сохранены на телефоне и будут переданы после привязки бота.');
        }); }} />
        <ActionButton label={load.data.telegram.pendingRevocation ? 'Повторить отзыв устройства' : load.data.telegram.linked ? 'Отключить и отозвать устройство' : 'Отменить подключение'} secondary disabled={busy} onPress={() => { void run(async () => { try { await disconnectTelegram(repository); setPairCode(''); setEndpoint(load.data!.telegram.origin); setMessage('Устройство отключено. Ключ больше не используется.'); } finally { await load.refresh(); } }); }} />
        {load.data.telegram.error ? <Text style={ui.error}>{load.data.telegram.error}</Text> : null}
        {load.data.telegram.conflict ? <Text style={ui.muted}>{load.data.telegram.conflict}</Text> : null}
      </> : <>
        <Field label="HTTPS-адрес вашего сервера" value={endpoint} onChangeText={setEndpoint} autoCapitalize="none" keyboardType="url" editable={!busy} placeholder="https://…" />
        <ActionButton label="Подключить Telegram" disabled={busy || !endpoint.trim()} onPress={() => Alert.alert('Разрешить синхронизацию?', 'Выбранный сервер и Telegram получат данные задач, короткие названия и стадии автомобилей, сроки проверок и итоги, которые вы отправите боту. Ключ устройства хранится в защищённом хранилище телефона.', [
          { text: 'Отмена', style: 'cancel' }, { text: 'Создать ссылку', onPress: () => { void run(async () => { const url = await pairTelegram(repository, endpoint); setEndpoint(''); await load.refresh(); await Linking.openURL(url); setMessage('Нажмите Start у бота, вернитесь в CRM и нажмите «Проверить привязку и синхронизировать».'); }); } },
        ])} />
      </>}
    </View> : null}
    {section === 'about' ? <View style={ui.card}><Text style={ui.heading}>Auto CRM</Text><Text style={ui.muted}>Офлайн CRM · данные на устройстве</Text></View> : null}
    {busy ? <Text accessibilityLiveRegion="polite" style={{ color: colors.accent }}>{message || 'Выполняем операцию… Не закрывайте приложение.'}</Text> : message ? <Text selectable style={{ color: colors.success }}>{message}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={ui.error}>{error}</Text> : null}
  </Page>;
}
