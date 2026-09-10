import type { ActivityType, PendingEntry } from '../../types';
import { getLocalDateString, getLogicalNow } from '../format-utils';
import { ACTIVITY_GOAL_ORDER } from '../activity-goals';

export interface TodayServerBase {
  today_by_activity_seconds?: Record<string, number>;
  today_active_seconds?: number;
  timezone?: string;
  cachedAt?: number;
}

export interface TodayProgress {
  byActivity: Partial<Record<ActivityType, number>>;
  activeMinutes: number;
}

// null: caller uses the local map
export function computeTodayProgress(
  cached: TodayServerBase | null,
  pending: PendingEntry[],
  todayKey: string,
  dayStartHour: number,
  browserTz: string
): TodayProgress | null {
  if (!cached) return null;

  const dayStart = getLogicalNow(dayStartHour);
  dayStart.setHours(dayStartHour, 0, 0, 0);
  const fresh = cached.cachedAt !== undefined && cached.cachedAt >= dayStart.getTime();
  const tzMatch = !cached.timezone || cached.timezone === browserTz;
  if (!fresh || !tzMatch) return null;

  const byActivity: Partial<Record<ActivityType, number>> = {};
  const serverByActivity = cached.today_by_activity_seconds;
  if (serverByActivity) {
    for (const [key, sec] of Object.entries(serverByActivity)) {
      if ((ACTIVITY_GOAL_ORDER as readonly string[]).includes(key)) {
        byActivity[key as ActivityType] = Math.floor(sec / 60);
      }
    }
  }
  let activeMinutes = Math.floor((cached.today_active_seconds ?? 0) / 60);

  for (const entry of pending) {
    if (entry.synced !== false || entry.serverEntryId !== null) continue;
    if (getLocalDateString(new Date(entry.date), dayStartHour) !== todayKey) continue;
    if (entry.activityType) {
      byActivity[entry.activityType] = (byActivity[entry.activityType] ?? 0) + entry.duration_min;
    }
    if (entry.isPassive === false) {
      activeMinutes += entry.duration_min;
    }
  }

  return { byActivity, activeMinutes };
}
