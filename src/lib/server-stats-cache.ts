import { STORAGE_KEYS } from '../types';
import { isAuthFailure } from './auth-helpers';
import { withStorageLock } from './storage-lock';
import { coalesceRefresh, postJsonWithRetry, type RefreshState } from './server-fetch';
import {
  applyAuthParams,
  awaitServerCacheStartup,
  buildCacheInvalidationPatch,
  buildOwnedCache,
  captureServerRequestContext,
  isContextStillCurrent,
  isCredentialStillCurrent,
  readServerCacheEpoch,
  requestCredentialsMode
} from './server-cache';

const REFRESH_THROTTLE_MS = 30000;
const refreshState: RefreshState = { inFlight: null, lastAttempt: 0 };

export interface ServerStatsCacheDeps {
  onAuthSuccess: () => Promise<void>;
  onAuthFailure: () => Promise<void>;
}

let deps: ServerStatsCacheDeps | null = null;

export function initServerStatsCache(next: ServerStatsCacheDeps): void {
  deps = next;
}

export function fetchAndCacheServerStats(force = false): Promise<void> {
  return coalesceRefresh(refreshState, REFRESH_THROTTLE_MS, force, runStatsFetch);
}

async function runStatsFetch(): Promise<void> {
  await awaitServerCacheStartup();
  const context = await captureServerRequestContext();
  if (!context) return;

  const params = new URLSearchParams();
  applyAuthParams(params, context, {
    token: 'jp343_extension_get_time_stats',
    nonce: 'jp343_get_time_stats'
  });

  const result = await postJsonWithRetry(context.ajaxUrl, params, 'get_time_stats', {
    credentials: requestCredentialsMode(context)
  });
  if (!result) return;

  if (result.success && result.data) {
    const value = { ...result.data, cachedAt: Date.now() };
    const written = await withStorageLock(async () => {
      if (!await isContextStillCurrent(context)) return false;
      const envelope = buildOwnedCache(context.ownerUserId, value, Date.now());
      await browser.storage.local.set({ [STORAGE_KEYS.CACHED_SERVER_STATS]: envelope });
      return true;
    });
    if (written) await deps?.onAuthSuccess();
    return;
  }

  if (isAuthFailure(result, context.credentialKind === 'token')) {
    if (await isCredentialStillCurrent(context)) await deps?.onAuthFailure();
  }
}

// Caller must hold the storage lock
export async function applyCacheInvalidation(): Promise<number> {
  const nextEpoch = await readServerCacheEpoch() + 1;
  await browser.storage.local.set(buildCacheInvalidationPatch(nextEpoch));
  return nextEpoch;
}

export async function invalidateServerCaches(): Promise<number> {
  return await withStorageLock(applyCacheInvalidation);
}
