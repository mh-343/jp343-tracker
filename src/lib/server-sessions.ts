import type { JP343UserState, CachedServerSession } from '../types';
import { STORAGE_KEYS } from '../types';
import { withStorageLock } from './storage-lock';
import { postJsonWithRetry, coalesceRefresh, type RefreshState } from './server-fetch';
import { applyLocalRenamesToSessions } from './background/custom-site-names';

const REFRESH_THROTTLE_MS = 30000;
const refreshState: RefreshState = { inFlight: null, lastAttempt: 0 };

export function fetchAndCacheServerSessions(force = false): Promise<void> {
  return coalesceRefresh(refreshState, REFRESH_THROTTLE_MS, force, runSessionsFetch);
}

async function runSessionsFetch(): Promise<void> {
  const userResult = await browser.storage.local.get(STORAGE_KEYS.USER);
  const userState = userResult[STORAGE_KEYS.USER] as JP343UserState | undefined;
  if (!userState?.isLoggedIn) return;

  const ajaxUrl = userState.ajaxUrl || 'https://jp343.com/wp-admin/admin-ajax.php';
  const params = new URLSearchParams();
  if (userState.extApiToken) {
    params.set('action', 'jp343_extension_get_recent_sessions');
    params.set('ext_api_token', userState.extApiToken);
  } else if (userState.nonce) {
    params.set('action', 'jp343_get_recent_sessions');
    params.set('nonce', userState.nonce);
  } else return;
  params.set('limit', '20');

  const result = await postJsonWithRetry(ajaxUrl, params, 'get_recent_sessions');
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
  }));

  await withStorageLock(async () => {
    const sessions = await applyLocalRenamesToSessions(mapped);
    await browser.storage.local.set({ [STORAGE_KEYS.CACHED_SERVER_SESSIONS]: sessions });
  });
}

export async function clearCachedServerSessions(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEYS.CACHED_SERVER_SESSIONS);
}
