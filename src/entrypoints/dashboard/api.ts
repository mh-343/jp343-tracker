import type { JP343UserState, DailyGoalsWire } from '../../types';
import { normalizeIsPassive, serverPassiveShare } from '../../lib/attention';
import type { SpeedLane, SpeedLanes, SpeedStatus } from '../../lib/reading-speed';

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
  daily?: { day: string; minutes: number }[];
  speed: SpeedLanes;
}

interface RawSpeedLane {
  lane?: unknown;
  medium?: unknown;
  platform?: unknown;
  status?: unknown;
  cph?: unknown;
  p25?: unknown;
  p75?: unknown;
  days?: unknown;
  secs?: unknown;
  need_days?: unknown;
  need_secs?: unknown;
}

type RawReadingStats = Omit<ServerReadingStatsResponse, 'speed'> & { speed_lanes?: unknown; primary_lane?: unknown };

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function toSpeedLane(raw: RawSpeedLane): SpeedLane | null {
  if (typeof raw.lane !== 'string' || (raw.medium !== 'text' && raw.medium !== 'manga')) return null;
  const status: SpeedStatus = raw.status === 'ok' || raw.status === 'stale' ? raw.status : 'learning';
  return {
    lane: raw.lane,
    medium: raw.medium,
    platform: typeof raw.platform === 'string' ? raw.platform : '',
    status,
    cph: numOrNull(raw.cph),
    p25: numOrNull(raw.p25),
    p75: numOrNull(raw.p75),
    days: numOrNull(raw.days) ?? 0,
    secs: numOrNull(raw.secs) ?? 0,
    needDays: numOrNull(raw.need_days) ?? 0,
    needSecs: numOrNull(raw.need_secs) ?? 0
  };
}

function toReadingStats(data: unknown): ServerReadingStatsResponse {
  const raw = (data && typeof data === 'object' ? data : { has_data: false }) as RawReadingStats;
  const { speed_lanes: rawLanes, primary_lane: rawPrimary, ...rest } = raw;
  const lanes = Array.isArray(rawLanes)
    ? rawLanes.map(l => toSpeedLane((l ?? {}) as RawSpeedLane)).filter((l): l is SpeedLane => l !== null)
    : [];
  return { ...rest, speed: { lanes, primary: typeof rawPrimary === 'string' ? rawPrimary : null } };
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
  attention_passive_share?: number | string | null;
  passiveShare?: number;
}

export async function ajaxPost(
  action: string,
  params: Record<string, string> = {},
  credentials: 'omit' | 'include' = 'include',
  timeoutMs = 15000
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ action, ...params });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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
      if (result.success) return toReadingStats(result.data);
    } catch {}
  }
  if (userState.nonce) {
    try {
      const result = await ajaxPost('jp343_get_reading_stats', { nonce: userState.nonce });
      if (result.success) return toReadingStats(result.data);
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
    passiveShare: serverPassiveShare(s),
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
