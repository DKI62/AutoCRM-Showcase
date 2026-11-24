import { createContext, useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Dimensions, Keyboard, Platform, TextInput, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { focusedFieldScroll, keyboardOverlap } from '../domain/form-viewport';

export const RevealField = createContext<((input: TextInput) => void) | null>(null);

export function useKeyboardVisible() {
  const [visible, setVisible] = useState(() => Keyboard.isVisible());
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return visible;
}

export function useAndroidKeyboardInset(enabled: boolean, systemBottom: number) {
  const page = useRef<View>(null);
  const [inset, setInset] = useState(0);
  const frame = useRef(0), revision = useRef(0);
  const cancel = useCallback(() => { cancelAnimationFrame(frame.current); revision.current++; }, []);
  const measure = useCallback(() => {
    if (!enabled) return;
    cancel();
    const token = revision.current;
    frame.current = requestAnimationFrame(() => {
      const keyboard = Keyboard.metrics();
      if (!keyboard || keyboard.height <= 0) return;
      page.current?.measureInWindow((_x, top, _width, height) => {
        if (token !== revision.current || !Keyboard.isVisible() || height <= 0) return;
        // adjustResize may already have moved the bottom edge above the IME.
        const imeTop = Math.min(keyboard.screenY, Dimensions.get('screen').height - systemBottom - keyboard.height);
        setInset(keyboardOverlap(top, height, imeTop));
      });
    });
  }, [cancel, enabled, systemBottom]);
  useEffect(() => {
    if (!enabled) return;
    const show = Keyboard.addListener('keyboardDidShow', measure);
    const hide = Keyboard.addListener('keyboardDidHide', () => { cancel(); setInset(0); });
    measure();
    return () => { show.remove(); hide.remove(); cancel(); };
  }, [cancel, enabled, measure]);
  return { page, measure, inset };
}

export function useFormScroll(scrollTo: (offset: number) => void, content?: RefObject<View | null>) {
  const viewport = useRef<View>(null);
  const field = useRef<TextInput | null>(null);
  const offset = useRef(0), frame = useRef(0), revision = useRef(0), lastHeight = useRef(0);
  const scrollTarget = useRef<number | null>(null);
  // Older Android versions can resize without emitting keyboardDidShow.
  const waitForIme = !!content && Number(Platform.Version) >= 30;
  const cancel = useCallback(() => { cancelAnimationFrame(frame.current); revision.current++; }, []);
  const reveal = useCallback(() => {
    cancel();
    const token = revision.current;
    frame.current = requestAnimationFrame(() => {
      const input = field.current;
      if (!input?.isFocused() || (waitForIme && !Keyboard.isVisible())) return;
      const apply = (top: number, height: number, fieldTop: number, fieldHeight: number) => {
        if (token !== revision.current || !input.isFocused() || height <= 24 || !fieldHeight) return;
        const next = focusedFieldScroll(offset.current, top, height, fieldTop, fieldHeight);
        if (Math.abs(next - offset.current) > 1 && (scrollTarget.current === null || Math.abs(next - scrollTarget.current) > 1)) {
          scrollTarget.current = next;
          scrollTo(next);
        }
      };
      const measureInWindow = () => viewport.current?.measureInWindow((_x, top, _width, height) => {
        input.measureInWindow((_x, fieldTop, _width, fieldHeight) => apply(top, height, fieldTop, fieldHeight));
      });
      if (content?.current) {
        // The input's content position stays stable while the scroll offset changes.
        input.measureLayout(content.current, (_x, top, _width, height) => apply(offset.current, lastHeight.current, top, height), measureInWindow);
      } else measureInWindow();
    });
  }, [cancel, content, scrollTo, waitForIme]);
  const cancelReveal = useCallback(() => { scrollTarget.current = null; cancel(); }, [cancel]);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', reveal);
    const hide = Keyboard.addListener('keyboardDidHide', cancelReveal);
    return () => { show.remove(); hide.remove(); cancelReveal(); };
  }, [cancelReveal, reveal]);
  const focus = useCallback((input: TextInput) => {
    if (field.current !== input) scrollTarget.current = null;
    field.current = input;
    reveal();
  }, [reveal]);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    const resizedForKeyboard = lastHeight.current > height;
    lastHeight.current = height;
    if (waitForIme ? Keyboard.isVisible() : resizedForKeyboard) reveal();
  }, [reveal, waitForIme]);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    offset.current = event.nativeEvent.contentOffset.y;
    if (scrollTarget.current !== null && Math.abs(scrollTarget.current - offset.current) <= 1) scrollTarget.current = null;
  }, []);
  return { viewport, focus, onLayout, onScroll, cancelReveal };
}
