import type { JP343UserState, CachedServerSession } from '../types';
import { STORAGE_KEYS } from '../types';

export async function fetchAndCacheServerSessions(): Promise<void> {
  try {
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

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);
    let response: Response;
    try {
      response = await fetch(ajaxUrl, { method: 'POST', signal: controller.signal, body: params });
    } finally { clearTimeout(t); }
    if (!response.ok) return;

    const result = await response.json();
    if (result.success && result.data?.sessions) {
      const sessions: CachedServerSession[] = (result.data.sessions as Record<string, unknown>[]).map(s => ({
        id: s.id as number | string,
        title: (s.project_name || s.title || 'Session') as string,
        platform: (s.platform || '') as string,
        duration_min: Math.round(((s.duration_seconds as number) || ((s.duration_minutes || s.minutes || 0) as number) * 60) / 60),
        date: ((s.logged_at || s.date || '') as string).replace(' ', 'T'),
        url: (s.resource_url || s.url || undefined) as string | undefined,
        thumbnail: (s.image || undefined) as string | undefined,
        activityType: (s.activity_type || undefined) as string | undefined,
      }));
      await browser.storage.local.set({ [STORAGE_KEYS.CACHED_SERVER_SESSIONS]: sessions });
    }
  } catch { /* server unreachable */ }
}

export async function clearCachedServerSessions(): Promise<void> {
  await browser.storage.local.remove(STORAGE_KEYS.CACHED_SERVER_SESSIONS);
}
