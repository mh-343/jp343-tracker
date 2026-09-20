import type { ExtensionMessage, DailyGoalsWire } from '../../types';
import { DEFAULT_STATS, STORAGE_KEYS } from '../../types';
import { loadPendingEntries } from '../pending-entries';
import { computeTodayProgress } from './activity-progress';
import { getLocalDateString, getLogicalNow } from '../format-utils';
import { withStorageLock } from '../storage-lock';
import { tracker } from '../time-tracker';
import { getMpchcState } from './mpchc-poller';
import { statsSnapshotRevision } from './stats-snapshot';
import { stableUserId } from '../auth-helpers';
import { loadUserState, readOwnedServerStats } from '../server-cache';
import type { BackgroundMessageContext } from './message-context';

interface CachedServerStats {
  total_seconds?: number;
  week_seconds?: number;
  today_seconds?: number;
  streak?: number;
  daily_minutes?: Record<string, number>;
  timezone?: string;
  calendar_week_seconds?: number;
  day_boundary_hour?: number;
  today_by_activity_seconds?: Record<string, number>;
  today_active_seconds?: number;
  daily_goals?: DailyGoalsWire | null;
  cachedAt?: number;
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
      await browser.tabs.create({ url: browser.runtime.getURL('/dashboard.html') });
      return { success: true };
    }

    case 'GET_STATS': {
      await context.recoveryReady;
      const revision = statsSnapshotRevision();
      const liveSessionId = tracker.getCurrentSession()?.id ?? null;
      const livePlayerSessionId = (await getMpchcState()).session?.id ?? null;
      if (revision === null) return { success: false, error: 'Stats updating' };
      void context.fetchAndCacheServerStats();
      const stats = await context.loadStats();
      const settings = await context.loadSettings();
      const dsh = settings.dayStartHour || 0;

      const now = getLogicalNow(dsh);
      const dayOfWeek = now.getDay();
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const monday = new Date(now);
      monday.setDate(now.getDate() + mondayOffset);
      monday.setHours(12, 0, 0, 0);
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
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = getLocalDateString(yesterday);
        const dayBeforeYesterday = new Date(now);
        dayBeforeYesterday.setDate(dayBeforeYesterday.getDate() - 2);
        const dayBeforeYesterdayStr = getLocalDateString(dayBeforeYesterday);
        if (stats.lastActiveDate !== todayStr
            && stats.lastActiveDate !== yesterdayStr
            && stats.lastActiveDate !== dayBeforeYesterdayStr) {
          streak = 0;
        }
      }

      let totalMinutes = stats.totalMinutes;
      let rawDailyMinutes = stats.dailyMinutes;

      const owner = stableUserId(await loadUserState());
      const envelope = await readOwnedServerStats(owner);
      const cached = envelope?.value as CachedServerStats | undefined;
      const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

      if (cached) {
        const serverTz = cached.timezone;
        const tzMatch = !serverTz || serverTz === browserTz;
        const cacheDay = cached.cachedAt === undefined ? '' : getLocalDateString(new Date(cached.cachedAt), dsh);
        const sameDay = cacheDay === todayStr;
        if (cached.today_seconds !== undefined && tzMatch && sameDay)
          todayMinutes = Math.max(todayMinutes, cached.today_seconds / 60);
        const serverWeekSec = cached.calendar_week_seconds ?? cached.week_seconds;
        if (serverWeekSec !== undefined && cacheDay >= mondayStr && cacheDay <= todayStr)
          weekMinutes = Math.max(weekMinutes, serverWeekSec / 60);
        if (cached.streak !== undefined) {
          const dayStart = getLogicalNow(dsh);
          dayStart.setHours(dsh, 0, 0, 0);
          // trust cache only if fetched today
          if (cached.cachedAt !== undefined && cached.cachedAt >= dayStart.getTime()) {
            streak = Math.max(streak, cached.streak);
          }
        }
        if (cached.total_seconds !== undefined) {
          const serverMinutes = Math.round(cached.total_seconds / 60);
          const MAX_UNSYNCED_DELTA = 1440;
          totalMinutes = Math.min(Math.max(totalMinutes, serverMinutes), serverMinutes + MAX_UNSYNCED_DELTA);
        }
        if (cached.daily_minutes) {
          const merged: Record<string, number> = { ...rawDailyMinutes };
          for (const [date, minutes] of Object.entries(cached.daily_minutes)) {
            merged[date] = Math.max(merged[date] || 0, minutes);
          }
          rawDailyMinutes = merged;
          todayMinutes = Math.max(todayMinutes, merged[todayStr] || 0);
          weekMinutes = Math.max(weekMinutes, Object.entries(merged)
            .filter(([day]) => day >= mondayStr && day <= todayStr)
            .reduce((sum, [, minutes]) => sum + minutes, 0));
        }
      }

      const pending = await loadPendingEntries();
      const progress = computeTodayProgress(cached ?? null, pending, todayStr, dsh, browserTz);
      const todayByActivity = progress ? progress.byActivity : (stats.dailyMinutesByActivity?.[todayStr] ?? {});
      const todayActiveMinutes = progress ? progress.activeMinutes : (stats.dailyActiveMinutes?.[todayStr] ?? 0);

      if (revision !== statsSnapshotRevision()
          || liveSessionId !== (tracker.getCurrentSession()?.id ?? null)
          || livePlayerSessionId !== ((await getMpchcState()).session?.id ?? null)
          || todayStr !== getLocalDateString(new Date(), dsh)) {
        return { success: false, error: 'Stats changed' };
      }

      return {
        success: true,
        data: {
          liveSessionId,
          livePlayerSessionId,
          dayKey: todayStr,
          dayStartHour: dsh,
          totalMinutes,
          weekMinutes,
          todayMinutes,
          streak,
          rawDailyMinutes,
          todayByActivity,
          todayActiveMinutes
        }
      };
    }

    case 'RESET_STATS': {
      await withStorageLock(async () => {
        await browser.storage.local.set({ [STORAGE_KEYS.STATS]: { ...DEFAULT_STATS } });
      });
      context.log('[JP343] Stats reset');
      return { success: true };
    }

    default:
      return { success: false, error: 'Unknown message type' };
  }
}
