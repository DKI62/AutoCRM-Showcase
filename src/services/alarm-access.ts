import { requireOptionalNativeModule } from 'expo-modules-core';
import { Linking, Platform } from 'react-native';

const access = requireOptionalNativeModule<{ canSchedule(): Promise<boolean>; openSettings(): Promise<void> }>('AutoCrmAlarmAccess');
export async function exactAlarmStatus(): Promise<boolean | null> {
  if (Platform.OS !== 'android') return null;
  if (Number(Platform.Version) < 31) return true;
  return access?.canSchedule().catch(() => null) ?? null;
}

export async function openExactAlarmSettings() {
  if (access) await access.openSettings().catch(() => Linking.openSettings());
  else await Linking.openSettings();
}
