import { STORAGE_KEYS } from '../types';
import { scheduleStatusBadgeUpdate } from './badge-service';

export function isAuthFailure(result: { success: boolean; data?: { code?: string } }): boolean {
  if (result.success) return false;
  const code = result.data?.code;
  return code === 'invalid_token' || code === 'E001' || code === 'invalid_nonce';
}

let authFailureHandled = false;

export async function handleAuthFailure(): Promise<void> {
  if (authFailureHandled) return;
  authFailureHandled = true;
  await browser.storage.local.remove([STORAGE_KEYS.USER, STORAGE_KEYS.DISPLAY_NAME]);
  scheduleStatusBadgeUpdate();
}
