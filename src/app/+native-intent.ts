import { receiveShare } from '../services/incoming-share';
import { sanitizeSystemPath } from '../services/system-path';

export async function redirectSystemPath({ path }: { path: string; initial: boolean }): Promise<string> {
  try {
    const safePath = sanitizeSystemPath(path);
    if (new URL(safePath, 'autocrm-showcase://app').hostname === 'expo-sharing') return receiveShare();
    return safePath;
  } catch { return '/add?shareError=1'; }
}
