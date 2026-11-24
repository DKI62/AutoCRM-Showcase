import { createContext, useContext } from 'react';
import { StyleSheet } from 'react-native';
import { palettes, type AppearanceMode, type ColorScheme } from './domain/appearance';

const styles = (colors: typeof palettes.dark) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, paddingTop: 10, gap: 10, width: '100%', maxWidth: 760, alignSelf: 'center' },
  listContent: { padding: 16, paddingTop: 12, gap: 0, width: '100%', maxWidth: 760, alignSelf: 'center' },
  buttonLabel: { fontSize: 14, lineHeight: 20, fontWeight: '600', textAlign: 'center', flexShrink: 1 },
  title: { color: colors.text, fontSize: 23, fontWeight: '700', lineHeight: 30 },
  heading: { color: colors.text, fontSize: 16, fontWeight: '600', lineHeight: 23 },
  body: { color: colors.text, fontSize: 14, lineHeight: 21 },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  label: { color: colors.muted, fontSize: 13, fontWeight: '500', marginBottom: 4 },
  input: { color: colors.text, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.controlBorder,
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, minHeight: 44, fontSize: 14 },
  error: { color: colors.danger, fontSize: 14, lineHeight: 21 },
  separator: { height: 1, backgroundColor: colors.border },
  card: { backgroundColor: colors.surface, borderRadius: 13, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, padding: 10, gap: 7 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  glyph: { backgroundColor: colors.raised, borderRadius: 16, width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  status: { alignSelf: 'flex-start', backgroundColor: colors.raised, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, fontSize: 12, lineHeight: 17 },
});

export const themes = {
  dark: { colors: palettes.dark, ui: styles(palettes.dark) },
  light: { colors: palettes.light, ui: styles(palettes.light) },
};

export const ThemeContext = createContext<typeof themes.dark & {
  scheme: ColorScheme;
  mode: AppearanceMode;
  changeMode: (mode: AppearanceMode) => Promise<void>;
}>({ ...themes.dark, scheme: 'dark', mode: 'dark', changeMode: async () => {} });

export function useTheme() {
  return useContext(ThemeContext);
}

export const formatDate = (timestamp: number) => new Date(timestamp).toLocaleString('ru-RU', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});
