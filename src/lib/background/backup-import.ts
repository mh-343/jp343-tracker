import type { ExtensionStats, PendingEntry } from '../../types';
import { STORAGE_KEYS, DEFAULT_STATS, PLATFORM_ACTIVITY_TYPE } from '../../types';
import { withStorageLock } from '../storage-lock';
import { withStatsUpdate } from './stats-snapshot';
import { readSyncPending } from './sync-queue';
import { recalculateStreak } from './stats-managers';

function assertFiniteImportedStats(stats: ExtensionStats): void {
  const maps = [stats.dailyMinutes, stats.hourlyMinutes, stats.readingDailyMinutes, stats.dailyActiveMinutes, stats.dailyPassiveMinutes];
  for (const map of maps) {
    if (map == null) continue;
    for (const value of Object.values(map)) {
      if (!Number.isFinite(value)) throw new Error('Invalid backup stats');
    }
  }
  for (const day of Object.values(stats.dailyMinutesByActivity ?? {})) {
    for (const value of Object.values(day ?? {})) {
      if (value !== undefined && !Number.isFinite(value)) throw new Error('Invalid backup stats');
    }
  }
  if (stats.totalMinutes !== undefined && !Number.isFinite(stats.totalMinutes)) {
    throw new Error('Invalid backup stats');
  }
}

export async function importPendingBackup(entries: PendingEntry[], stats: ExtensionStats, dayStartHour: number): Promise<number> {
  if (!Array.isArray(entries) || !stats || typeof stats.dailyMinutes !== 'object' || entries.some(e =>
    !e || typeof e.id !== 'string' || !e.id || typeof e.date !== 'string' || typeof e.project_id !== 'string'
    || !Number.isFinite(e.duration_min) || e.duration_min < 0 || !(e.platform in PLATFORM_ACTIVITY_TYPE)
  )) throw new Error('Invalid backup sessions');
  assertFiniteImportedStats(stats);
  return withStatsUpdate(() => withStorageLock(async () => {
    const pending = await readSyncPending();
    const ids = new Set(pending.map(e => e.id));
    const added = entries.filter(e => {
      if (ids.has(e.id)) return false;
      ids.add(e.id);
      return true;
    });
    const stored = await browser.storage.local.get(STORAGE_KEYS.STATS);
    const current = (stored[STORAGE_KEYS.STATS] ?? DEFAULT_STATS) as ExtensionStats;
    await browser.storage.local.set({
      [STORAGE_KEYS.PENDING]: [...pending, ...added],
      [STORAGE_KEYS.STATS]: mergeStats(current, stats, dayStartHour)
    });
    return added.length;
  }));
}

function mergeStats(local: ExtensionStats, imported: ExtensionStats, dayStartHour: number): ExtensionStats {
  const num = (value: number | undefined): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;

  const mergeMap = (a?: Record<string, number>, b?: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(a ?? {})) out[key] = num(value);
    for (const [key, value] of Object.entries(b ?? {})) out[key] = Math.max(out[key] ?? 0, num(value));
    return out;
  };

  const mergedDaily = mergeMap(local.dailyMinutes, imported.dailyMinutes);

  const mergedByActivity: Record<string, Record<string, number>> = {};
  for (const [day, acts] of Object.entries(local.dailyMinutesByActivity ?? {})) {
    const dst: Record<string, number> = {};
    for (const [act, value] of Object.entries(acts ?? {})) dst[act] = num(value);
    mergedByActivity[day] = dst;
  }
  for (const [day, acts] of Object.entries(imported.dailyMinutesByActivity ?? {})) {
    const dst = mergedByActivity[day] ?? (mergedByActivity[day] = {});
    for (const [act, value] of Object.entries(acts ?? {})) dst[act] = Math.max(dst[act] ?? 0, num(value));
  }

  const dailyTotal = Object.values(mergedDaily).reduce((sum, m) => sum + m, 0);
  const lastActiveDate = local.lastActiveDate > (imported.lastActiveDate || '')
    ? local.lastActiveDate
    : (imported.lastActiveDate || local.lastActiveDate);

  return {
    totalMinutes: Math.max(dailyTotal, num(local.totalMinutes), num(imported.totalMinutes)),
    dailyMinutes: mergedDaily,
    lastActiveDate,
    currentStreak: recalculateStreak(mergedDaily, dayStartHour),
    hourlyMinutes: mergeMap(local.hourlyMinutes, imported.hourlyMinutes),
    readingDailyMinutes: mergeMap(local.readingDailyMinutes, imported.readingDailyMinutes),
    dailyActiveMinutes: mergeMap(local.dailyActiveMinutes, imported.dailyActiveMinutes),
    dailyPassiveMinutes: mergeMap(local.dailyPassiveMinutes, imported.dailyPassiveMinutes),
    dailyMinutesByActivity: mergedByActivity
  };
}
