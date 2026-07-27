import type { AuthTransition, ChannelSyncState, ExtensionSettings, JP343UserState } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { withStorageLock } from '../storage-lock';
import { mergeAuthState, normalizeAjaxUrl, stableUserId } from '../auth-helpers';
import { buildCacheInvalidationPatch, readServerCacheEpoch } from '../server-cache';

const DEFAULT_AJAX_URL = 'https://jp343.com/wp-admin/admin-ajax.php';
const RECOVERY_COOLDOWN_MS = 60_000;

export type AuthRecoveryStatus = 'healed' | 'expired' | 'transient';

export interface AuthRecoveryResult {
  status: AuthRecoveryStatus;
  userState: JP343UserState | null;
}

interface NonceRefreshData {
  userId?: number | null;
  nonce?: string | null;
  ajaxUrl?: string | null;
  extApiToken?: string | null;
  avatarUrlSmall?: string | null;
}

function resolveAjaxUrl(userState: JP343UserState): string {
  return normalizeAjaxUrl(userState.ajaxUrl) ?? DEFAULT_AJAX_URL;
}

function freshChannelSyncState(ownerUserId: number): ChannelSyncState {
  return {
    initialized: false,
    ownerUserId,
    serverVersion: 0,
    serverSnapshot: { blocked: [], whitelisted: [] },
    pendingOps: [],
    lastPullAt: null
  };
}

export interface AuthCommitResult {
  state: JP343UserState;
  identityChanged: boolean;
  rejected: boolean;
}

export async function commitAuthState(
  incoming: Partial<JP343UserState> | null | undefined,
  transition: AuthTransition,
  options: { displayName?: string } = {}
): Promise<AuthCommitResult> {
  return await withStorageLock(async () => {
    const stored = await browser.storage.local.get(STORAGE_KEYS.USER);
    const previous = (stored[STORAGE_KEYS.USER] as JP343UserState | undefined) ?? null;
    const merged = mergeAuthState(previous, incoming, transition);
    if (merged.rejected) {
      return { state: merged.state, identityChanged: false, rejected: true };
    }

    const ownerChanged = merged.identityChanged || transition === 'explicit-logout';
    const patch: Record<string, unknown> = { [STORAGE_KEYS.USER]: merged.state };

    if (ownerChanged) {
      Object.assign(patch, buildCacheInvalidationPatch(await readServerCacheEpoch() + 1));
      const nextOwner = stableUserId(merged.state);
      patch[STORAGE_KEYS.CHANNEL_SYNC] = nextOwner === null ? null : freshChannelSyncState(nextOwner);
      patch[STORAGE_KEYS.AVATAR_DATA] = null;
      patch[STORAGE_KEYS.AVATAR_USER_ID] = null;
      patch[STORAGE_KEYS.DISPLAY_NAME] = null;
      const settingsRes = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
      const settings = settingsRes[STORAGE_KEYS.SETTINGS] as ExtensionSettings | undefined;
      if (settings) {
        patch[STORAGE_KEYS.SETTINGS] = { ...settings, blockedChannels: [], whitelistedChannels: [] };
      }
    }

    if (options.displayName) patch[STORAGE_KEYS.DISPLAY_NAME] = options.displayName;

    await browser.storage.local.set(patch);
    return { state: merged.state, identityChanged: merged.identityChanged, rejected: false };
  });
}

async function recoverAuth(userState: JP343UserState): Promise<AuthRecoveryResult> {
  const ajaxUrl = resolveAjaxUrl(userState);
  let text: string;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let resp: Response;
    try {
      resp = await fetch(ajaxUrl, {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
        body: new URLSearchParams({
          action: 'jp343_extension_nonce_refresh',
          ext_version: browser.runtime.getManifest().version,
        }),
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!resp.ok) return { status: 'transient', userState: null };
    text = await resp.text();
  } catch {
    return { status: 'transient', userState: null };
  }

  if (text === '0' || text.trim() === '') return { status: 'expired', userState: null };

  let parsed: { success?: boolean; data?: NonceRefreshData };
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'expired', userState: null };
  }

  if (parsed.success && parsed.data?.nonce) {
    const d = parsed.data;
    const incoming: Partial<JP343UserState> = {
      isLoggedIn: true,
      userId: d.userId ?? userState.userId,
      nonce: d.nonce,
      ajaxUrl: normalizeAjaxUrl(d.ajaxUrl) ?? ajaxUrl,
      extApiToken: d.extApiToken ?? null
    };
    if (d.avatarUrlSmall !== undefined) incoming.avatarUrlSmall = d.avatarUrlSmall || null;
    const commit = await commitAuthState(incoming, 'authoritative');
    if (commit.rejected) return { status: 'expired', userState: null };
    return { status: 'healed', userState: commit.state };
  }
  return { status: 'expired', userState: null };
}

let lastAttemptAt = 0;
let inFlight: Promise<AuthRecoveryResult> | null = null;

export async function attemptRecovery(userState?: JP343UserState | null): Promise<AuthRecoveryResult> {
  if (inFlight) return inFlight;
  if (Date.now() - lastAttemptAt < RECOVERY_COOLDOWN_MS) {
    return { status: 'transient', userState: null };
  }
  lastAttemptAt = Date.now();

  inFlight = (async (): Promise<AuthRecoveryResult> => {
    const stored = (await browser.storage.local.get(STORAGE_KEYS.USER))[STORAGE_KEYS.USER] as JP343UserState | undefined;
    const state = userState ?? stored ?? null;
    if (!state) return { status: 'transient', userState: null };
    const result = await recoverAuth(state);
    if (result.status === 'healed') {
      await clearReloginHint();
    } else if (result.status === 'expired') {
      await setReloginHint();
    }
    return result;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function setReloginHint(): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.RELOGIN_REQUIRED]: Date.now() });
}

export async function clearReloginHint(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEYS.RELOGIN_REQUIRED);
}
