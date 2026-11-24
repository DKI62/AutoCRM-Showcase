import { isUuid } from './telegram-protocol';

export const pairingVersion = 2;
export const pairingCodePattern = /^[0-9a-f]{12}$/;
export interface PairingCandidate {
  requestId: string;
  displayName: string | null;
  username: string | null;
}

export function pairingOffer(value: unknown) {
  const result = value as { pairingVersion?: unknown; deviceId?: unknown; deviceToken?: unknown; bindUrl?: unknown } | null;
  if (result?.pairingVersion !== pairingVersion || !isUuid(result.deviceId) ||
    typeof result.deviceToken !== 'string' || !/^[a-f0-9]{64}$/.test(result.deviceToken) ||
    typeof result.bindUrl !== 'string' || !/^https:\/\/telegram\.fixture\.invalid\/[a-z0-9_]+\?start=pair2_[a-f0-9]{32}$/i.test(result.bindUrl)) return null;
  return { deviceId: result.deviceId, token: result.deviceToken, bindUrl: result.bindUrl };
}
