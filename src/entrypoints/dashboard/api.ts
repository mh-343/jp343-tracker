import type { JP343UserState, DailyGoalsWire } from '../../types';
import { normalizeIsPassive } from '../../lib/attention';

export const AJAX_URL = 'https://jp343.com/wp-admin/admin-ajax.php';

export interface ServerStatsResponse {
  total_seconds?: number;
  week_seconds?: number;
  today_seconds?: number;
  streak?: number;
  daily_avg_seconds?: number;
  daily_minutes?: Record<string, number>;
  daily_active_minutes?: Record<string, number>;
  daily_passive_minutes?: Record<string, number>;
  daily_podcast_minutes?: Record<string, number>;
  timezone?: string;
  calendar_week_seconds?: number;
  calendar_week_active_seconds?: number;
  calendar_week_passive_seconds?: number;
  calendar_month_seconds?: number;
  day_boundary_hour?: number;
  today_by_activity_seconds?: Record<string, number>;
  today_active_seconds?: number;
  daily_goals?: DailyGoalsWire | null;
  hourly_minutes?: Record<string, number>;
  first_session_times?: Record<string, string>;
  has_unread_ticket?: boolean;
  has_ticket_replies?: boolean;
  cachedAt?: number;
}

export interface ServerReadingStatsResponse {
  has_data: boolean;
  today_minutes?: number;
  total_minutes?: number;
  total_chars?: number;
  reading_speed?: number | null;
  daily?: { day: string; minutes: number }[];
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
  is_passive?: number | string | null;
  isPassive?: boolean;
}

export async function ajaxPost(
  action: string,
  params: Record<string, string> = {},
  credentials: 'omit' | 'include' = 'include'
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ action, ...params });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(AJAX_URL, {
      method: 'POST',
      credentials,
      signal: controller.signal,
      body
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchServerStats(userState: JP343UserState): Promise<ServerStatsResponse | null> {
  if (userState.extApiToken) {
    try {
      const result = await ajaxPost('jp343_extension_get_time_stats', {
        ext_api_token: userState.extApiToken
      }, 'omit');
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

export async function fetchReadingStats(userState: JP343UserState): Promise<ServerReadingStatsResponse | null> {
  if (userState.extApiToken) {
    try {
      const result = await ajaxPost('jp343_extension_get_reading_stats', {
        ext_api_token: userState.extApiToken
      }, 'omit');
      if (result.success) return result.data as ServerReadingStatsResponse;
    } catch {}
  }
  if (userState.nonce) {
    try {
      const result = await ajaxPost('jp343_get_reading_stats', { nonce: userState.nonce });
      if (result.success) return result.data as ServerReadingStatsResponse;
    } catch {}
  }
  return null;
}

function normalizeServerDate(raw: string): string {
  if (!raw) return raw;
  if (/T.*[Z+\-]\d/.test(raw)) return raw;
  const repaired = raw.replace(' ', 'T');
  if (!isNaN(new Date(repaired).getTime())) return repaired;
  return raw;
}

function normalizeServerSessions(raw: ServerSession[]): ServerSession[] {
  return raw.map(s => ({
    ...s,
    title: s.title || s.project_name || 'Session',
    date: normalizeServerDate(s.date || s.logged_at || ''),
    duration_seconds: s.duration_seconds ?? (s.duration_minutes ?? s.minutes ?? 0) * 60,
    url: s.resource_url || s.url || undefined,
    isPassive: normalizeIsPassive(s.is_passive),
  }));
}

export async function fetchServerSessions(userState: JP343UserState, limit = 20): Promise<ServerSession[] | null> {
  if (userState.extApiToken) {
    try {
      const result = await ajaxPost('jp343_extension_get_recent_sessions', {
        ext_api_token: userState.extApiToken,
        limit: String(limit)
      }, 'omit');
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
