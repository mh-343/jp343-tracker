import { STORAGE_KEYS } from '../../types';
import type { GsmState } from '../gsm/state';
import { emptyGsmState, GSM_ORIGINS } from '../gsm/state';
import { withStorageLock } from '../storage-lock';

export async function getGsmState(): Promise<GsmState> {
  const stored = (await browser.storage.local.get(STORAGE_KEYS.GSM))[STORAGE_KEYS.GSM] as Partial<GsmState> | undefined;
  return { ...emptyGsmState(), ...stored };
}

// read-modify-write: a running sync never undoes a toggle
export async function patchGsmState(patch: Partial<GsmState>, onlyForEnabledAt?: number): Promise<GsmState> {
  return withStorageLock(async () => {
    const current = await getGsmState();
    if (onlyForEnabledAt !== undefined && current.enabledAt !== onlyForEnabledAt) return current;
    const next = { ...current, ...patch };
    if (!next.enabled) next.status = 'off';
    await browser.storage.local.set({ [STORAGE_KEYS.GSM]: next });
    return next;
  });
}

export async function gsmAccess(): Promise<'ok' | 'desktop_only' | 'permission_needed'> {
  if ((await browser.runtime.getPlatformInfo()).os === 'android') return 'desktop_only';
  return await browser.permissions.contains({ origins: GSM_ORIGINS }) ? 'ok' : 'permission_needed';
}

// switching on starts counting from now; db id is kept
export async function writeGsmEnabled(enabled: boolean): Promise<GsmState> {
  return withStorageLock(async () => {
    const current = await getGsmState();
    const next: GsmState = enabled && !current.enabled
      ? {
          ...current, enabled: true, enabledAt: Math.floor(Date.now() / 1000), fullCursor: null,
          lastHot: null, lastFull: null, status: 'connecting', rejectedCount: 0, oversizedDays: 0, failures: 0, lbExcluded: {},
          serverFingerprint: null, serverSentAt: null, serverTriedAt: null,
        }
      : { ...current, enabled, status: enabled ? current.status : 'off' };
    if (next.enabledAt !== current.enabledAt) await browser.storage.local.remove(STORAGE_KEYS.GSM_OUTBOX);
    await browser.storage.local.set({ [STORAGE_KEYS.GSM]: next });
    return next;
  });
}
