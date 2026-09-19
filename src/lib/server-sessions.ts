import type { CachedServerSession } from '../types';
import { STORAGE_KEYS } from '../types';
import { withStorageLock } from './storage-lock';
import { postJsonWithRetry, coalesceRefresh, type RefreshState } from './server-fetch';
import { applyLocalRenamesToSessions } from './background/custom-site-names';
import { reconcileDeletedServerEntries } from './background/server-session-reconcile';
import { normalizeIsPassive } from './attention';
import {
  applyAuthParams,
  awaitServerCacheStartup,
  buildOwnedCache,
  captureServerRequestContext,
  isContextStillCurrent,
  requestCredentialsMode
} from './server-cache';

const REFRESH_THROTTLE_MS = 30000;
const refreshState: RefreshState = { inFlight: null, lastAttempt: 0 };

export function fetchAndCacheServerSessions(force = false): Promise<void> {
  return coalesceRefresh(refreshState, REFRESH_THROTTLE_MS, force, runSessionsFetch);
}

async function runSessionsFetch(): Promise<void> {
  await awaitServerCacheStartup();
  const context = await captureServerRequestContext();
  if (!context) return;

  const params = new URLSearchParams();
  applyAuthParams(params, context, {
    token: 'jp343_extension_get_recent_sessions',
    nonce: 'jp343_get_recent_sessions'
  });
  params.set('limit', '20');

  const requestedAt = Date.now();
  const result = await postJsonWithRetry(context.ajaxUrl, params, 'get_recent_sessions', {
    credentials: requestCredentialsMode(context)
  });
  const rawSessions = result?.data?.sessions;
  if (!result?.success || !Array.isArray(rawSessions)) return;

  const mapped: CachedServerSession[] = (rawSessions as Record<string, unknown>[]).map(s => ({
    id: s.id as number | string,
    project_id: (s.project_id || '') as string,
    title: (s.project_name || s.title || 'Session') as string,
    platform: (s.platform || '') as string,
    duration_min: Math.round(((s.duration_seconds as number) || ((s.duration_minutes || s.minutes || 0) as number) * 60) / 60),
    date: ((s.logged_at || s.date || '') as string).replace(' ', 'T'),
    url: (s.resource_url || s.url || undefined) as string | undefined,
    thumbnail: (s.image || undefined) as string | undefined,
    activityType: (s.activity_type || undefined) as string | undefined,
    isPassive: normalizeIsPassive(s.is_passive),
  }));

  const wrote = await withStorageLock(async () => {
    const sessions = await applyLocalRenamesToSessions(mapped);
    if (!await isContextStillCurrent(context)) return false;
    const envelope = buildOwnedCache(context.ownerUserId, sessions, Date.now());
    await browser.storage.local.set({ [STORAGE_KEYS.CACHED_SERVER_SESSIONS]: envelope });
    return true;
  });
  if (wrote) await reconcileDeletedServerEntries(requestedAt);
}
