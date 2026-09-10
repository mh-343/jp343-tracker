import type { ExtensionStats, ExtensionSettings, PendingEntry } from '../../types';
import { DEFAULT_STATS, STORAGE_KEYS } from '../../types';
import { getLocalDateString, getLogicalNow } from '../format-utils';
import { withStorageLock } from '../storage-lock';
import { isReading } from '../time-tracker';
import { addHourlyMinutes, subtractHourlyMinutes } from './hourly-stats';
import { loadPendingEntries } from '../pending-entries';

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

function addToActivityMap(stats: ExtensionStats, entry: PendingEntry, entryDate: string): void {
  if (!entry.activityType) return;
  const byActivity = (stats.dailyMinutesByActivity ??= {});
  const dayMap = (byActivity[entryDate] ??= {});
  dayMap[entry.activityType] = (dayMap[entry.activityType] || 0) + entry.duration_min;
}

export async function updateStats(entry: PendingEntry): Promise<void> {
  await withStorageLock(async () => {
    try {
      const stats = await loadStats();
      const settings = await deps.loadSettings();
      const dsh = settings.dayStartHour || 0;
      const entryDate = getLocalDateString(new Date(entry.date), dsh);

      stats.totalMinutes += entry.duration_min;
      stats.dailyMinutes[entryDate] = (stats.dailyMinutes[entryDate] || 0) + entry.duration_min;
      addHourlyMinutes(stats, entry);

      if (isReading(entry)) {
        stats.readingDailyMinutes ??= {};
        stats.readingDailyMinutes[entryDate] = (stats.readingDailyMinutes[entryDate] || 0) + entry.duration_min;
      }

      if (typeof entry.isPassive === 'boolean') {
        const attentionMap = entry.isPassive
          ? (stats.dailyPassiveMinutes ??= {})
          : (stats.dailyActiveMinutes ??= {});
        attentionMap[entryDate] = (attentionMap[entryDate] || 0) + entry.duration_min;
      }

      addToActivityMap(stats, entry, entryDate);

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 90);
      const cutoffStr = getLocalDateString(cutoff);
      for (const dateKey of Object.keys(stats.dailyMinutes)) {
        if (dateKey < cutoffStr) {
          delete stats.dailyMinutes[dateKey];
        }
      }
      for (const map of [stats.readingDailyMinutes, stats.dailyActiveMinutes, stats.dailyPassiveMinutes]) {
        if (!map) continue;
        for (const dateKey of Object.keys(map)) {
          if (dateKey < cutoffStr) {
            delete map[dateKey];
          }
        }
      }
      if (stats.dailyMinutesByActivity) {
        for (const dateKey of Object.keys(stats.dailyMinutesByActivity)) {
          if (dateKey < cutoffStr) {
            delete stats.dailyMinutesByActivity[dateKey];
          }
        }
      }

      stats.currentStreak = recalculateStreak(stats.dailyMinutes, dsh);
      const dateKeys = Object.keys(stats.dailyMinutes).sort();
      stats.lastActiveDate = dateKeys.length > 0 ? dateKeys[dateKeys.length - 1] : '';

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
  let graceUsed = false;
  const checkDate = new Date(today);

  for (let i = 0; i < 365; i++) {
    const dateStr = getLocalDateString(checkDate);
    if ((dailyMinutes[dateStr] || 0) > 0) {
      streak++;
      graceUsed = false;
      checkDate.setDate(checkDate.getDate() - 1);
    } else if (i === 0) {
      checkDate.setDate(checkDate.getDate() - 1);
      continue;
    } else if (!graceUsed) {
      graceUsed = true;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

export function applyStatsSubtraction(
  stats: ExtensionStats,
  entry: PendingEntry,
  dayStartHour: number
): ExtensionStats {
  const entryDate = getLocalDateString(new Date(entry.date), dayStartHour);

  stats.totalMinutes = Math.max(0, stats.totalMinutes - entry.duration_min);
  if (stats.dailyMinutes[entryDate]) {
    stats.dailyMinutes[entryDate] = Math.max(0, stats.dailyMinutes[entryDate] - entry.duration_min);
    if (stats.dailyMinutes[entryDate] <= 0) {
      delete stats.dailyMinutes[entryDate];
    }
  }
  if (isReading(entry) && stats.readingDailyMinutes?.[entryDate]) {
    stats.readingDailyMinutes[entryDate] = Math.max(0, stats.readingDailyMinutes[entryDate] - entry.duration_min);
    if (stats.readingDailyMinutes[entryDate] <= 0) {
      delete stats.readingDailyMinutes[entryDate];
    }
  }
  if (typeof entry.isPassive === 'boolean') {
    const attentionMap = entry.isPassive ? stats.dailyPassiveMinutes : stats.dailyActiveMinutes;
    if (attentionMap?.[entryDate]) {
      attentionMap[entryDate] = Math.max(0, attentionMap[entryDate] - entry.duration_min);
      if (attentionMap[entryDate] <= 0) {
        delete attentionMap[entryDate];
      }
    }
  }
  if (entry.activityType) {
    const dayMap = stats.dailyMinutesByActivity?.[entryDate];
    const current = dayMap?.[entry.activityType];
    if (dayMap && current) {
      const next = Math.max(0, current - entry.duration_min);
      if (next <= 0) delete dayMap[entry.activityType]; else dayMap[entry.activityType] = next;
      if (Object.keys(dayMap).length === 0 && stats.dailyMinutesByActivity) delete stats.dailyMinutesByActivity[entryDate];
    }
  }
  subtractHourlyMinutes(stats, entry);

  stats.currentStreak = recalculateStreak(stats.dailyMinutes, dayStartHour);

  const dates = Object.keys(stats.dailyMinutes).sort();
  stats.lastActiveDate = dates.length > 0 ? dates[dates.length - 1] : '';
  return stats;
}

export interface AttentionRetagMove {
  entry: PendingEntry;
  oldIsPassive: boolean | undefined;
}

// Caller must hold the storage lock
export async function applyAttentionRetagToStats(moves: AttentionRetagMove[]): Promise<void> {
  if (moves.length === 0) return;
  try {
    const stats = await loadStats();
    const settings = await deps.loadSettings();
    const dsh = settings.dayStartHour || 0;
    for (const { entry, oldIsPassive } of moves) {
      const entryDate = getLocalDateString(new Date(entry.date), dsh);
      if (typeof oldIsPassive === 'boolean') {
        const oldMap = oldIsPassive ? stats.dailyPassiveMinutes : stats.dailyActiveMinutes;
        if (oldMap?.[entryDate]) {
          oldMap[entryDate] = Math.max(0, oldMap[entryDate] - entry.duration_min);
          if (oldMap[entryDate] <= 0) {
            delete oldMap[entryDate];
          }
        }
      }
      if (typeof entry.isPassive === 'boolean') {
        const newMap = entry.isPassive
          ? (stats.dailyPassiveMinutes ??= {})
          : (stats.dailyActiveMinutes ??= {});
        newMap[entryDate] = (newMap[entryDate] || 0) + entry.duration_min;
      }
    }
    await browser.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
  } catch (error) {
    deps.log('[JP343] Failed to apply retag to stats:', error);
  }
}

// Caller must hold the storage lock
export async function buildStatsAfterSubtraction(entry: PendingEntry): Promise<ExtensionStats | null> {
  try {
    const stats = await loadStats();
    const settings = await deps.loadSettings();
    return applyStatsSubtraction(stats, entry, settings.dayStartHour || 0);
  } catch (error) {
    deps.log('[JP343] Failed to build subtracted stats:', error);
    return null;
  }
}

export async function subtractFromStats(entry: PendingEntry): Promise<void> {
  await withStorageLock(async () => {
    const stats = await buildStatsAfterSubtraction(entry);
    if (!stats) return;
    await browser.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
    deps.log('[JP343] Stats after deletion: total=' + Math.round(stats.totalMinutes) + 'm, streak=' + stats.currentStreak);
  });
}

// Backfill map once from pending entries
export async function seedDailyMinutesByActivity(): Promise<void> {
  await withStorageLock(async () => {
    try {
      const stats = await loadStats();
      if (stats.dailyMinutesByActivity !== undefined) return;
      const settings = await deps.loadSettings();
      const dsh = settings.dayStartHour || 0;
      const pending = await loadPendingEntries();
      for (const entry of pending) {
        const entryDate = getLocalDateString(new Date(entry.date), dsh);
        addToActivityMap(stats, entry, entryDate);
      }
      stats.dailyMinutesByActivity ??= {};
      await browser.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
    } catch (error) {
      deps.log('[JP343] Failed to seed activity map:', error);
    }
  });
}
