import type { ExtensionStats, ExtensionSettings, PendingEntry } from '../../types';
import { DEFAULT_STATS, STORAGE_KEYS } from '../../types';
import { getLocalDateString, getLogicalNow } from '../format-utils';
import { withStorageLock } from '../storage-lock';
import { addHourlyMinutes, subtractHourlyMinutes } from './hourly-stats';

interface StatsManagerDeps {
  log: (...args: unknown[]) => void;
  loadSettings: () => Promise<ExtensionSettings>;
}

let deps: StatsManagerDeps = {
  log: () => {},
  loadSettings: () => Promise.reject(new Error('not initialized')),
};

export function initStatsCallbacks(callbacks: StatsManagerDeps): void {
  deps = callbacks;
}

export async function loadStats(): Promise<ExtensionStats> {
  try {
    const result = await browser.storage.local.get(STORAGE_KEYS.STATS);
    return result[STORAGE_KEYS.STATS] || { ...DEFAULT_STATS };
  } catch {
    return { ...DEFAULT_STATS };
  }
}

export async function updateStats(entry: PendingEntry): Promise<void> {
  await withStorageLock(async () => {
    try {
      const stats = await loadStats();
      const settings = await deps.loadSettings();
      const dsh = settings.dayStartHour || 0;
      const entryDate = getLocalDateString(new Date(entry.date), dsh);
      const logicalNow = getLogicalNow(dsh);
      const today = getLocalDateString(logicalNow);

      stats.totalMinutes += entry.duration_min;
      stats.dailyMinutes[entryDate] = (stats.dailyMinutes[entryDate] || 0) + entry.duration_min;
      addHourlyMinutes(stats, entry);

      if (stats.lastActiveDate !== today) {
        const yesterday = new Date(logicalNow);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = getLocalDateString(yesterday);

        if (stats.lastActiveDate === yesterdayStr) {
          stats.currentStreak += 1;
        } else if (stats.lastActiveDate !== today) {
          stats.currentStreak = 1;
        }
        stats.lastActiveDate = today;
      }

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 90);
      const cutoffStr = getLocalDateString(cutoff);
      for (const dateKey of Object.keys(stats.dailyMinutes)) {
        if (dateKey < cutoffStr) {
          delete stats.dailyMinutes[dateKey];
        }
      }

      await browser.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
      deps.log('[JP343] Stats updated: total=' + Math.round(stats.totalMinutes) + 'm, streak=' + stats.currentStreak);
    } catch (error) {
      deps.log('[JP343] Failed to update stats:', error);
    }
  });
}

export function recalculateStreak(dailyMinutes: Record<string, number>, dayStartHour = 0): number {
  const today = getLogicalNow(dayStartHour);
  today.setHours(12, 0, 0, 0);

  let streak = 0;
  const checkDate = new Date(today);

  for (let i = 0; i < 365; i++) {
    const dateStr = getLocalDateString(checkDate);
    if ((dailyMinutes[dateStr] || 0) > 0) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else if (i === 0) {
      checkDate.setDate(checkDate.getDate() - 1);
      continue;
    } else {
      break;
    }
  }
  return streak;
}

export async function subtractFromStats(entry: PendingEntry): Promise<void> {
  await withStorageLock(async () => {
    try {
      const stats = await loadStats();
      const settings = await deps.loadSettings();
      const entryDate = getLocalDateString(new Date(entry.date), settings.dayStartHour || 0);

      stats.totalMinutes = Math.max(0, stats.totalMinutes - entry.duration_min);
      if (stats.dailyMinutes[entryDate]) {
        stats.dailyMinutes[entryDate] = Math.max(0, stats.dailyMinutes[entryDate] - entry.duration_min);
        if (stats.dailyMinutes[entryDate] <= 0) {
          delete stats.dailyMinutes[entryDate];
        }
      }
      subtractHourlyMinutes(stats, entry);

      stats.currentStreak = recalculateStreak(stats.dailyMinutes, settings.dayStartHour || 0);

      const dates = Object.keys(stats.dailyMinutes).sort();
      stats.lastActiveDate = dates.length > 0 ? dates[dates.length - 1] : '';

      await browser.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
      deps.log('[JP343] Stats after deletion: total=' + Math.round(stats.totalMinutes) + 'm, streak=' + stats.currentStreak);
    } catch (error) {
      deps.log('[JP343] Failed to subtract stats:', error);
    }
  });
}
