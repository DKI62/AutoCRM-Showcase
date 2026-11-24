import { randomUUID } from 'expo-crypto';
import { hide as hideSplash } from 'expo-splash-screen';
import { openDatabaseAsync } from 'expo-sqlite';
import { createContext, use, useEffect, useState, type ReactNode } from 'react';
import { Platform, Text, View } from 'react-native';
import { ActionButton } from '../components/action-button';
import { AppThemeProvider } from '../components/app-theme-provider';
import { readAppearance, type AppearanceMode } from '../domain/appearance';
import { CrmRepository } from '../repositories/crm-repository';
import { settings } from '../settings';
import { useTheme } from '../theme';
import { migrate } from './migrations';
import { createRepositorySession } from './repository-session';
import { diagnostic, startDiagnostics } from '../services/diagnostics';

const RepositoryContext = createContext<CrmRepository | null>(null);
const runtime = globalThis as typeof globalThis & { autoCrmRepositorySession?: ReturnType<typeof createRepositorySession> };
// Fast Refresh can replace JS modules. Keep one queue per runtime and bypass Android's native handle cache.
const openRepository = runtime.autoCrmRepositorySession ??= createRepositorySession(
  async () => {
    startDiagnostics();
    diagnostic('sqlite.open');
    return openDatabaseAsync(settings.databaseName, Platform.OS === 'android' ? { useNewConnection: true } : undefined);
  },
  async db => { await migrate(db); diagnostic('sqlite.ready'); },
  randomUUID,
);

export function AppProvider({ children }: { children: ReactNode }) {
  const { ui } = useTheme();
  const [session, setSession] = useState<{ repository: CrmRepository; initialMode: AppearanceMode } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const Repository = CrmRepository;
  useEffect(() => {
    let active = true;
    openRepository(Repository).then(async repository => {
      const initialMode = await readAppearance(repository);
      if (active) setSession({ repository, initialMode });
    }).catch((cause: unknown) => {
      diagnostic('sqlite.error');
      if (active) setError(cause instanceof Error ? cause.message : 'Не удалось открыть локальную базу.');
    });
    return () => { active = false; };
  }, [attempt, Repository]);
  if (!session || session.repository.constructor !== Repository) return error
    ? <View onLayout={hideSplash} style={[ui.screen, { justifyContent: 'center', padding: 24, gap: 20 }]}>
      <Text style={ui.heading}>Не удалось открыть данные</Text><Text style={ui.error}>{error}</Text>
      <Text style={ui.muted}>Существующая база сохранена. Повторите попытку.</Text>
      <ActionButton label="Повторить" onPress={() => { setError(null); setAttempt(a => a + 1); }} />
    </View>
    : null;
  return <RepositoryContext value={session.repository}>
    <AppThemeProvider initialMode={session.initialMode} repository={session.repository}>{children}</AppThemeProvider>
  </RepositoryContext>;
}

export function useRepository(): CrmRepository {
  const repository = use(RepositoryContext);
  if (!repository) throw new Error('Repository is not initialized');
  return repository;
}
