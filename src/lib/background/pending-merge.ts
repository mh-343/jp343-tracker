import type { PendingEntry } from '../../types';
import { getLocalDateString } from '../format-utils';
import { readerForPlatform } from '../reader-sources';

export function findMergeTarget(
  pending: PendingEntry[],
  entry: PendingEntry,
  dayStartHour: number
): PendingEntry | undefined {
  const entryDay = getLocalDateString(new Date(entry.date), dayStartHour);
  const isReaderEntry = !!readerForPlatform(entry.platform);
  return pending.find(e =>
    e.project_id === entry.project_id &&
    (isReaderEntry || e.project === entry.project) &&
    getLocalDateString(new Date(e.date), dayStartHour) === entryDay
  );
}

export function applyMergeUpdate(mergeTarget: PendingEntry, entry: PendingEntry): void {
  const source = readerForPlatform(entry.platform);
  if (source && entry.project && !source.fallbackNameRe.test(entry.project)) {
    mergeTarget.project = entry.project;
  }
  mergeTarget.duration_min += entry.duration_min;
  if (entry.chars) mergeTarget.chars = (mergeTarget.chars ?? 0) + entry.chars;
  if (!mergeTarget.thumbnail && entry.thumbnail) {
    mergeTarget.thumbnail = entry.thumbnail;
  }
  if (mergeTarget.synced) {
    mergeTarget.synced = false;
    mergeTarget.syncedAt = null;
    mergeTarget.syncAttempts = 0;
    mergeTarget.lastSyncError = null;
    mergeTarget.mergeResync = true;
  }
}
