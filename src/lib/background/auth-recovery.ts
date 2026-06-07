import type { JP343UserState } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { withStorageLock } from '../storage-lock';

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

function isJp343AjaxUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') {
      return u.hostname === 'jp343.com' || u.hostname.endsWith('.jp343.com');
    }
    return import.meta.env.DEV && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

function resolveAjaxUrl(userState: JP343UserState): string {
  const url = userState.ajaxUrl;
  return url && isJp343AjaxUrl(url) ? url : DEFAULT_AJAX_URL;
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
    const merged: JP343UserState = {
      isLoggedIn: true,
      userId: d.userId ?? userState.userId,
      nonce: d.nonce!,
      ajaxUrl: d.ajaxUrl && isJp343AjaxUrl(d.ajaxUrl) ? d.ajaxUrl : ajaxUrl,
      extApiToken: d.extApiToken || userState.extApiToken || null,
      avatarUrlSmall: d.avatarUrlSmall !== undefined ? (d.avatarUrlSmall || null) : (userState.avatarUrlSmall ?? null),
    };
    await withStorageLock(async () => {
      await browser.storage.local.set({ [STORAGE_KEYS.USER]: merged });
    });
    return { status: 'healed', userState: merged };
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
