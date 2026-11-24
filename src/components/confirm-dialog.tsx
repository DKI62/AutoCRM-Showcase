import { Modal, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useCallback, useRef, type ReactNode } from 'react';
import { useTheme } from '../theme';
import { ActionButton } from './action-button';
import { RevealField, useFormScroll } from './form-scroll';

export function ConfirmDialog({ title, visible, children, onClose, busy = false, closeLabel = 'Отмена' }: {
  title: string; visible: boolean; children: ReactNode; onClose: () => void; busy?: boolean; closeLabel?: string;
}) {
  const { colors, ui } = useTheme();
  const scroll = useRef<ScrollView>(null);
  const { viewport, focus, onLayout, onScroll } = useFormScroll(useCallback(y => scroll.current?.scrollTo({ y, animated: true }), []));
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={() => { if (!busy) onClose(); }}>
    <SafeAreaView style={{ flex: 1, justifyContent: 'center', padding: 20, backgroundColor: colors.scrim }}>
      <View accessibilityViewIsModal style={[ui.card, { width: '100%', maxWidth: 480, alignSelf: 'center', padding: 16, maxHeight: '90%', backgroundColor: colors.raised }]}>
        <Text accessibilityRole="header" style={ui.heading}>{title}</Text>
        <View ref={viewport} collapsable={false} onLayout={onLayout} style={{ flexShrink: 1 }}>
          <RevealField.Provider value={focus}>
            <ScrollView ref={scroll} onScroll={onScroll} scrollEventThrottle={16} scrollsChildToFocus={false} style={{ flexGrow: 0, flexShrink: 1 }}
              keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8, paddingVertical: 12 }}>{children}</ScrollView>
          </RevealField.Provider>
        </View>
        <ActionButton label={closeLabel} secondary disabled={busy} onPress={onClose} />
      </View>
    </SafeAreaView>
  </Modal>;
}

export function SelectionToolbar({ count, onRemove, onCancel }: { count: number; onRemove: () => void; onCancel: () => void }) {
  const { ui } = useTheme();
  return <View style={[ui.card, ui.row, { flexWrap: 'wrap' }]}>
    <Text style={[ui.body, { flexGrow: 1 }]}>Выбрано: {count}</Text>
    <ActionButton label="Удалить" disabled={!count} compact onPress={onRemove} />
    <ActionButton label="Отмена" secondary compact onPress={onCancel} />
  </View>;
}
