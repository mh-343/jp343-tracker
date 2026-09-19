import type { ExtensionSettings, PendingEntry, SavePendingResult } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { withStorageLock } from '../storage-lock';
import { readSyncPending } from './sync-queue';
import { shouldSkipYoutubeMusic } from '../youtube-music';
import { updateBadge } from '../badge-service';
import { updateStats } from './stats-managers';
import { findMergeTarget, applyMergeUpdate } from './pending-merge';

interface PendingStoreDeps {
  loadSettings: () => Promise<ExtensionSettings>;
  log: (...args: unknown[]) => void;
}

export async function storePendingEntry(
  entry: PendingEntry,
  bypassMusicSkip: boolean,
  deps: PendingStoreDeps
): Promise<SavePendingResult> {
  const result = await withStorageLock<SavePendingResult>(async () => {
    try {
      const pending = await readSyncPending();
      if (pending.some(e => e.id === entry.id || (entry.platform === 'mpchc' && e.mergedSessionIds?.includes(entry.id)))) return 'duplicate';

      const settings = await deps.loadSettings();
      if (!bypassMusicSkip && shouldSkipYoutubeMusic(entry, settings)) return 'skipped';
      if (settings.mergeSameDaySessions) {
        const dsh = settings.dayStartHour || 0;
        const mergeTarget = findMergeTarget(pending, entry, dsh);
        if (mergeTarget) {
          applyMergeUpdate(mergeTarget, entry);
          await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: pending });
          deps.log('[JP343] Session merged. Total:', mergeTarget.duration_min.toFixed(1), 'min');
          return 'merged';
        }
      }

      pending.push(entry);
      await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: pending });
      deps.log('[JP343] Entry saved. Pending:', pending.length);
      updateBadge();
      return 'saved';
    } catch (error) {
      deps.log('[JP343] Failed to save entry:', error);
      return 'error';
    }
  });
  if (result === 'saved' || result === 'merged') await updateStats(entry);
  return result;
}
