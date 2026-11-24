import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useContext, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View, type ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { ActionButton } from './action-button';
import { useRepository } from '../storage/app-provider';
import { RevealField, useAndroidKeyboardInset, useFormScroll, useKeyboardVisible } from './form-scroll';

export type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];
export function Icon({ name, size = 22, color }: { name: IconName; size?: number; color?: ColorValue }) {
  const { colors } = useTheme();
  return <MaterialCommunityIcons name={name} size={size} color={color ?? colors.accent} />;
}
export function IconButton({ name, label, onPress, disabled = false }: { name: IconName; label: string; onPress: () => void; disabled?: boolean }) {
  const { colors } = useTheme();
  return <Pressable accessibilityLabel={label} accessibilityRole="button" disabled={disabled} onPress={onPress}
    android_ripple={{ color: colors.border }} style={{ padding: 10, minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : 1 }}><Icon name={name} /></Pressable>;
}
export function Page({ children, footer, tabInset = false, avoidAndroidKeyboard = false }: {
  children: ReactNode; footer?: ReactNode; tabInset?: boolean; avoidAndroidKeyboard?: boolean;
}) {
  const { colors, ui } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardVisible();
  const scroll = useRef<ScrollView>(null);
  const content = useRef<View>(null);
  const androidForm = avoidAndroidKeyboard && Platform.OS === 'android';
  const { page, measure, inset } = useAndroidKeyboardInset(androidForm, insets.bottom);
  const { viewport, focus, onLayout, onScroll, cancelReveal } = useFormScroll(useCallback(y => scroll.current?.scrollTo({ y, animated: true }), []),
    androidForm ? content : undefined);
  const bottom = keyboard || tabInset ? 0 : insets.bottom;
  const contentStyle = [ui.content, { paddingLeft: 16 + insets.left, paddingRight: 16 + insets.right, paddingBottom: 16 + (footer ? 0 : bottom) }];
  return <View ref={page} collapsable={false} onLayout={androidForm ? measure : undefined} style={ui.screen}>
    <KeyboardAvoidingView style={ui.screen} enabled={Platform.OS === 'ios'} behavior="padding">
    <View ref={viewport} collapsable={false} onLayout={onLayout} style={{ flex: 1 }}>
      <RevealField.Provider value={focus}>
        <ScrollView ref={scroll} onScroll={onScroll} onScrollBeginDrag={cancelReveal} scrollEventThrottle={16} scrollsChildToFocus={false}
          contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled"
          contentContainerStyle={androidForm ? undefined : contentStyle}>
          {androidForm ? <View ref={content} collapsable={false} style={contentStyle}>{children}</View> : children}
        </ScrollView>
      </RevealField.Provider>
    </View>
    {footer ? <View style={{ borderTopWidth: 1, borderColor: colors.border }}><View style={[ui.content, {
      paddingTop: keyboard ? 4 : 8, paddingBottom: Math.max(keyboard ? 4 : 8, bottom), paddingLeft: 16 + insets.left, paddingRight: 16 + insets.right, gap: 4,
    }]}>{footer}</View></View> : null}
    {androidForm && keyboard && inset > 0 ? <View pointerEvents="none" style={{ height: inset }} /> : null}
    </KeyboardAvoidingView>
  </View>;
}
export function Field({ label, labelAction, multiline, onFocus, onLayout, ...props }: Omit<ComponentProps<typeof TextInput>, 'ref'> & { label: string; labelAction?: ReactNode }) {
  const { colors, ui } = useTheme();
  const reveal = useContext(RevealField);
  const input = useRef<TextInput>(null);
  return <View><View style={[ui.row, { alignItems: 'baseline' }]}><Text style={[ui.label, { flex: 1 }]}>{label}</Text>{labelAction}</View><TextInput ref={input} accessibilityLabel={label} placeholderTextColor={colors.muted}
    {...props} multiline={multiline} onFocus={event => { if (input.current) reveal?.(input.current); onFocus?.(event); }}
    onLayout={event => { if (input.current?.isFocused() && Keyboard.isVisible()) reveal?.(input.current); onLayout?.(event); }}
    style={[ui.input, multiline && { minHeight: 76, maxHeight: 148, textAlignVertical: 'top' }, props.style]} /></View>;
}
export { Chips } from './filter-chips';
export function Empty({ title, body, icon = 'car-outline' }: { title: string; body: string; icon?: IconName }) {
  const { ui } = useTheme();
  return <View style={{ paddingVertical: 24, alignItems: 'center', gap: 12 }}><Icon name={icon} size={38} /><Text style={[ui.heading, { textAlign: 'center' }]}>{title}</Text><Text style={[ui.muted, { textAlign: 'center', maxWidth: 320 }]}>{body}</Text></View>;
}
export function LoadState({ loading, error, retry }: { loading: boolean; error: string | null; retry: () => void }) {
  const { colors, ui } = useTheme();
  return loading ? <ActivityIndicator color={colors.accent} style={{ padding: 30 }} /> : error ? <View style={{ gap: 12 }}><Text accessibilityRole="alert" style={ui.error}>{error}</Text><ActionButton label="Повторить" secondary onPress={retry} /></View> : null;
}
export function useLoad<T>(loader: () => Promise<T>) {
  const repository = useRepository();
  const [data, setData] = useState<T | null>(null), [error, setError] = useState<string | null>(null), [loading, setLoading] = useState(true);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const token = ++request.current; setLoading(true); setError(null);
    try { const value = await loader(); if (token === request.current) setData(value); }
    catch (cause) { if (token === request.current) setError(cause instanceof Error ? cause.message : 'Не удалось прочитать данные.'); }
    finally { if (token === request.current) setLoading(false); }
  }, [loader]);
  useFocusEffect(useCallback(() => { void refresh(); const unsubscribe = repository.subscribe(() => { void refresh(); }); return () => { unsubscribe(); request.current++; }; }, [refresh, repository]));
  return { data, loading, error, refresh };
}
