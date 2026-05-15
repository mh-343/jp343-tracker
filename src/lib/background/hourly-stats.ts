import type { ExtensionStats, PendingEntry } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { loadPendingEntries } from '../pending-entries';

export function addHourlyMinutes(stats: ExtensionStats, entry: PendingEntry): void {
  if (!stats.hourlyMinutes) stats.hourlyMinutes = {};
  const hourKey = String(new Date(entry.date).getHours());
  stats.hourlyMinutes[hourKey] = (stats.hourlyMinutes[hourKey] || 0) + entry.duration_min;
}

export function subtractHourlyMinutes(stats: ExtensionStats, entry: PendingEntry): void {
  if (!stats.hourlyMinutes) return;
  const hourKey = String(new Date(entry.date).getHours());
  if (stats.hourlyMinutes[hourKey]) {
    stats.hourlyMinutes[hourKey] = Math.max(0, stats.hourlyMinutes[hourKey] - entry.duration_min);
  }
}

export async function migrateHourlyMinutes(): Promise<void> {
  const result = await browser.storage.local.get(STORAGE_KEYS.STATS);
  const stats: ExtensionStats = result[STORAGE_KEYS.STATS];
  if (!stats) return;
  if (stats.hourlyMinutes && Object.keys(stats.hourlyMinutes).length > 0) return;

  const pending = await loadPendingEntries();
  const hourly: Record<string, number> = {};
  for (const entry of pending) {
    if (!entry.date || !entry.duration_min) continue;
    const hour = String(new Date(entry.date).getHours());
    hourly[hour] = (hourly[hour] || 0) + entry.duration_min;
  }
  stats.hourlyMinutes = hourly;
  await browser.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
}
