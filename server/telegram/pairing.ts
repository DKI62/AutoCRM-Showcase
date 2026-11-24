import { digest } from '../../src/services/telegram-protocol';
import type { Environment } from './worker';

export function pairingLinkHash(env: Environment, code: string) {
  return digest(`${env.FIXTURE_PAIRING_PEPPER}:link-v2:${code}`);
}

export async function pairingProof(env: Environment, requestId: string, chat: string) {
  return (await digest(`${env.FIXTURE_PAIRING_PEPPER}:confirm-v2:${requestId}:${chat}`)).slice(0, 12);
}
