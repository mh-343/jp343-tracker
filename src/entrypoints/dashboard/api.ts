import type { JP343UserState } from '../../types';

export const AJAX_URL = 'https://jp343.com/wp-admin/admin-ajax.php';

export interface ServerStatsResponse {
  total_seconds?: number;
  week_seconds?: number;
  today_seconds?: number;
  streak?: number;
  daily_avg_seconds?: number;
  daily_minutes?: Record<string, number>;
  timezone?: string;
  calendar_week_seconds?: number;
}

export interface ServerSession {
  id: number | string;
  project_id?: string;
  project_name?: string;
  title?: string;
  icon?: string;
  color?: string;
  image?: string;
  platform?: string;
  duration_minutes?: number;
  minutes?: number;
  duration_seconds?: number;
  logged_at?: string;
  date?: string;
  relative?: string;
  notes?: string;
  has_notes?: boolean;
  resource_url?: string;
  url?: string;
  activity_type?: string;
}

export async function ajaxPost(action: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ action, ...params });
  const response = await fetch(AJAX_URL, {
    method: 'POST',
    credentials: 'include',
    body
  });
  return response.json();
}

export async function fetchServerStats(userState: JP343UserState): Promise<ServerStatsResponse | null> {
  if (userState.extApiToken) {
    try {
      const result = await ajaxPost('jp343_extension_get_time_stats', {
        ext_api_token: userState.extApiToken
      });
      if (result.success) return result.data as ServerStatsResponse;
    } catch {}
  }
  if (userState.nonce) {
    try {
      const result = await ajaxPost('jp343_get_time_stats', { nonce: userState.nonce });
      if (result.success) return result.data as ServerStatsResponse;
    } catch {}
  }
  return null;
}

function normalizeServerSessions(raw: ServerSession[]): ServerSession[] {
  return raw.map(s => ({
    ...s,
    title: s.title || s.project_name || 'Session',
    date: s.date || s.logged_at || '',
    duration_seconds: s.duration_seconds ?? (s.duration_minutes ?? s.minutes ?? 0) * 60,
    url: s.resource_url || s.url || undefined,
  }));
}

export async function fetchServerSessions(userState: JP343UserState, limit = 20): Promise<ServerSession[] | null> {
  if (userState.extApiToken) {
    try {
      const result = await ajaxPost('jp343_extension_get_recent_sessions', {
        ext_api_token: userState.extApiToken,
        limit: String(limit)
      });
      if (result.success && result.data?.sessions) return normalizeServerSessions(result.data.sessions as ServerSession[]);
    } catch {}
  }
  if (userState.nonce) {
    try {
      const result = await ajaxPost('jp343_get_recent_sessions', {
        nonce: userState.nonce,
        limit: String(limit)
      });
      if (result.success && result.data?.sessions) return normalizeServerSessions(result.data.sessions as ServerSession[]);
    } catch {}
  }
  return null;
}
