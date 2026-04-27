import type { ExtensionMessage } from '../../types';
import { DEFAULT_STATS, STORAGE_KEYS } from '../../types';
import { getLocalDateString } from '../format-utils';
import type { BackgroundMessageContext } from './message-context';

interface CachedServerStats {
  total_seconds?: number;
  week_seconds?: number;
  today_seconds?: number;
  streak?: number;
  daily_minutes?: Record<string, number>;
  timezone?: string;
  calendar_week_seconds?: number;
}

export async function handleStatsSyncMessage(
  message: ExtensionMessage,
  context: BackgroundMessageContext
): Promise<unknown> {
  switch (message.type) {
    case 'SYNC_ENTRIES_DIRECT': {
      const result = await context.syncEntriesDirect();
      return { success: true, data: result };
    }

    case 'OPEN_DASHBOARD': {
      await browser.tabs.create({ url: browser.runtime.getURL('dashboard.html') });
      return { success: true };
    }

    case 'GET_STATS': {
      const stats = await context.loadStats();

      const now = new Date();
      const dayOfWeek = now.getDay();
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const monday = new Date(now);
      monday.setDate(now.getDate() + mondayOffset);
      monday.setHours(0, 0, 0, 0);
      const mondayStr = getLocalDateString(monday);

      let weekMinutes = 0;
      const todayStr = getLocalDateString(now);
      let todayMinutes = stats.dailyMinutes[todayStr] || 0;

      for (const [dateKey, minutes] of Object.entries(stats.dailyMinutes)) {
        if (dateKey >= mondayStr) {
          weekMinutes += minutes;
        }
      }

      let streak = stats.currentStreak;
      if (stats.lastActiveDate) {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = getLocalDateString(yesterday);
        if (stats.lastActiveDate !== todayStr && stats.lastActiveDate !== yesterdayStr) {
          streak = 0;
        }
      }

      let totalMinutes = stats.totalMinutes;
      let rawDailyMinutes = stats.dailyMinutes;

      const cachedResult = await browser.storage.local.get(STORAGE_KEYS.CACHED_SERVER_STATS);
      const cached = cachedResult[STORAGE_KEYS.CACHED_SERVER_STATS] as CachedServerStats | undefined;

      if (cached) {
        const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const serverTz = cached.timezone;
        const tzMatch = !serverTz || serverTz === browserTz;
        if (cached.today_seconds !== undefined && tzMatch)
          todayMinutes = Math.max(todayMinutes, Math.round(cached.today_seconds / 60));
        const serverWeekSec = cached.calendar_week_seconds ?? cached.week_seconds;
        if (serverWeekSec !== undefined)
          weekMinutes = Math.max(weekMinutes, Math.round(serverWeekSec / 60));
        if (cached.streak !== undefined)
          streak = Math.max(streak, cached.streak);
        if (cached.total_seconds !== undefined)
          totalMinutes = Math.max(totalMinutes, Math.round(cached.total_seconds / 60));
        if (cached.daily_minutes) {
          const merged: Record<string, number> = { ...rawDailyMinutes };
          for (const [date, minutes] of Object.entries(cached.daily_minutes)) {
            merged[date] = Math.max(merged[date] || 0, minutes);
          }
          rawDailyMinutes = merged;
        }
      }

      return {
        success: true,
        data: {
          totalMinutes,
          weekMinutes,
          todayMinutes,
          streak,
          rawDailyMinutes
        }
      };
    }

    case 'RESET_STATS': {
      await browser.storage.local.set({ [STORAGE_KEYS.STATS]: { ...DEFAULT_STATS } });
      context.log('[JP343] Stats reset');
      return { success: true };
    }

    default:
      return { success: false, error: 'Unknown message type' };
  }
}
