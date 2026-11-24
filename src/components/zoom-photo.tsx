import { Image } from 'expo-image';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image as NativeImage, PanResponder, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';
import { updatePhotoLoad, type PhotoLoad } from '../domain/photo-load';
import { useTheme } from '../theme';
import { ActionButton } from './action-button';

type Transform = { zoom: number; x: number; y: number };
const reset = { zoom: 1, x: 0, y: 0 };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function distance(event: GestureResponderEvent) {
  const [a, b] = event.nativeEvent.touches;
  return a && b ? Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY) : 0;
}

export function ZoomPhoto({ uri, width, height, onZoom, onRetry }: {
  uri: string; width: number; height: number; onZoom: (zoomed: boolean) => void; onRetry: () => void;
}) {
  const { colors, ui } = useTheme();
  const current = useRef<Transform>(reset), start = useRef({ ...reset, distance: 0 });
  const aspect = useRef(width / height);
  const [transform, setTransform] = useState<Transform>(reset);
  const [load, setLoad] = useState<PhotoLoad>('expo');
  const ready = load === 'expo-ready' || load === 'native-ready';
  const loading = load === 'expo' || load === 'native';
  function complete(from: 'expo' | 'native', succeeded: boolean) {
    setLoad(current => updatePhotoLoad(current, from, succeeded));
  }
  useEffect(() => {
    if (load !== 'expo' && load !== 'native') return;
    const timer = setTimeout(() => setLoad(current => updatePhotoLoad(current, load, false)), 10000);
    return () => clearTimeout(timer);
  }, [load]);
  const pan = useMemo(() => {
    const canClaim = (event: GestureResponderEvent) => event.nativeEvent.touches.length >= 2 || current.current.zoom > 1.01;
    const settle = () => {
      if (current.current.zoom <= 1.01) { current.current = reset; setTransform(reset); }
      onZoom(current.current.zoom > 1.01);
    };
    // PanResponder.create registers these callbacks. It reads their refs only on touch events.
    // eslint-disable-next-line react-hooks/refs
    return PanResponder.create({
      onStartShouldSetPanResponder: event => ready && event.nativeEvent.touches.length >= 2,
      onMoveShouldSetPanResponderCapture: event => ready && canClaim(event),
      onPanResponderGrant: event => { start.current = { ...current.current, distance: distance(event) }; onZoom(true); },
      onPanResponderMove: (event, gesture) => {
        const gap = distance(event);
        if (gap && !start.current.distance) start.current = { ...current.current, distance: gap };
        const zoom = gap ? clamp(start.current.zoom * gap / start.current.distance, 1, 4) : current.current.zoom;
        const fitWidth = Math.min(width, height * aspect.current), fitHeight = fitWidth / aspect.current;
        const x = Math.max(0, (fitWidth * zoom - width) / 2), y = Math.max(0, (fitHeight * zoom - height) / 2);
        current.current = { zoom, x: clamp(start.current.x + gesture.dx, -x, x), y: clamp(start.current.y + gesture.dy, -y, y) };
        setTransform(current.current);
      },
      onPanResponderRelease: settle,
      onPanResponderTerminate: settle,
      onPanResponderTerminationRequest: () => false,
    });
  }, [width, height, onZoom, ready]);
  const imageStyle = { width, height, opacity: ready ? 1 : 0, transform: [{ translateX: transform.x }, { translateY: transform.y }, { scale: transform.zoom }] };
  function updateAspect(w: number, h: number) { if (w > 0 && h > 0) aspect.current = w / h; }
  return <View {...pan.panHandlers} style={{ width, height, overflow: 'hidden' }}>
    {load !== 'failed' && (load === 'expo' || load === 'expo-ready'
      ? <Image source={{ uri }} contentFit="contain" cachePolicy="memory" accessibilityLabel="Фотография автомобиля"
        onLoad={({ source }) => updateAspect(source.width, source.height)} onDisplay={() => complete('expo', true)}
        style={imageStyle} onError={() => complete('expo', false)} />
      : <NativeImage source={{ uri }} resizeMode="contain" resizeMethod="resize" accessibilityLabel="Фотография автомобиля"
        onLoad={({ nativeEvent: { source } }) => { updateAspect(source.width, source.height); complete('native', true); }}
        style={imageStyle} onError={() => complete('native', false)} />)}
    {loading ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', gap: 8 }]}>
      <ActivityIndicator color={colors.accent} /><Text style={ui.muted}>Открываем фото…</Text>
    </View> : null}
    {load === 'failed' ? <View style={[StyleSheet.absoluteFill, { justifyContent: 'center', padding: 20, gap: 8 }]}>
      <Text accessibilityRole="alert" style={ui.error}>Фото не удалось открыть. Проверьте, открывается ли исходный файл.</Text>
      <ActionButton label="Загрузить снова" secondary onPress={onRetry} />
    </View> : null}
  </View>;
}
