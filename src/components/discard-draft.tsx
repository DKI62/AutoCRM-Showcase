import { useNavigation, usePreventRemove, type NavigationAction } from 'expo-router/react-navigation';
import { useState } from 'react';
import { Keyboard } from 'react-native';
import { ActionButton } from './action-button';
import { ConfirmDialog } from './confirm-dialog';

export function useDiscardDraft(dirty: boolean, busy: boolean, isBusy?: () => boolean) {
  const navigation = useNavigation();
  const [action, setAction] = useState<NavigationAction | null>(null);
  usePreventRemove(dirty || busy, ({ data }) => {
    if (busy || isBusy?.()) return;
    Keyboard.dismiss();
    setAction(current => current ?? data.action);
  });
  return action ? <ConfirmDialog title="Изменения не сохранены" visible closeLabel="Продолжить редактирование"
    onClose={() => setAction(null)}>
    <ActionButton label="Покинуть без сохранения" onPress={() => {
      setAction(null);
      navigation.dispatch(action);
    }} />
  </ConfirmDialog> : null;
}
