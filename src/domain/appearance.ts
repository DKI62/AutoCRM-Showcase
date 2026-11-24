export type ColorScheme = 'light' | 'dark';
export type AppearanceMode = ColorScheme | 'system';

const settingKey = 'appearance_mode';

export async function readAppearance(store: { getSetting: (key: string) => Promise<string | null> }): Promise<AppearanceMode> {
  const value = await store.getSetting(settingKey);
  return value === 'light' || value === 'system' ? value : 'dark';
}

export function saveAppearance(store: { setSetting: (key: string, value: string) => Promise<void> }, mode: AppearanceMode) {
  return store.setSetting(settingKey, mode);
}

export function resolveAppearance(mode: AppearanceMode, system: ColorScheme | 'unspecified' | null | undefined): ColorScheme {
  return mode === 'system' ? (system === 'light' ? 'light' : 'dark') : mode;
}

export const palettes = {
  dark: {
    background: '#101019', surface: '#1A1A29', raised: '#242438', border: '#323248', controlBorder: '#323248',
    text: '#F5F4FA', muted: '#A6A6B9', accent: '#B4A8FF', primary: '#6050D2', primaryPressed: '#5140B7',
    primarySoft: '#302C55', danger: '#FF8296', warning: '#F4C66D', success: '#7BDDB1',
    onPrimary: '#F5F4FA', onAccent: '#101019', scrim: '#080812CC',
  },
  light: {
    background: '#FAFAFC', surface: '#ECEAF5', raised: '#E3E0F1', border: '#D6D4E2', controlBorder: '#858096',
    text: '#191727', muted: '#555268', accent: '#5140AF', primary: '#5544BC', primaryPressed: '#453699',
    primarySoft: '#E7E0FC', danger: '#A31F43', warning: '#765012', success: '#176548',
    onPrimary: '#FFFFFF', onAccent: '#FFFFFF', scrim: '#211B3566',
  },
};
