import { useLayoutEffect, useState, type ReactNode } from 'react';
import { Appearance, useColorScheme } from 'react-native';
import { resolveAppearance, saveAppearance, type AppearanceMode } from '../domain/appearance';
import type { CrmRepository } from '../repositories/crm-repository';
import { ThemeContext, themes } from '../theme';

export function AppThemeProvider({ initialMode, repository, children }: {
  initialMode: AppearanceMode;
  repository: CrmRepository;
  children: ReactNode;
}) {
  const [mode, setMode] = useState(initialMode);
  const system = useColorScheme();
  const scheme = resolveAppearance(mode, system);

  useLayoutEffect(() => {
    Appearance.setColorScheme(mode === 'system' ? 'unspecified' : mode);
  }, [mode]);

  async function changeMode(next: AppearanceMode) {
    if (mode === next) return;
    await saveAppearance(repository, next);
    setMode(next);
  }

  return <ThemeContext value={{ ...themes[scheme], mode, scheme, changeMode }}>{children}</ThemeContext>;
}
