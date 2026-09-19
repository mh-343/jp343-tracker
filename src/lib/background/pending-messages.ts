import type { ExtensionMessage, PendingEntry, CachedServerSession, Platform, ActivityType, SavePendingResult } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { updateBadge } from '../badge-service';
import { loadPendingEntries } from '../pending-entries';
import { readSyncPending } from './sync-queue';
import { fetchAndCacheServerSessions } from '../server-sessions';
import { withStorageLock } from '../storage-lock';
import { getLocalDateString, getWeekDates } from '../format-utils';
import { subtractSessionFromServerStats, type DecrementableServerStats } from '../server-stats';
import { loadDeletedSnapshots, buildStashedSnapshots, hasDeletedSnapshot, takeDeletedSnapshot, putDeletedSnapshot, currentUserId, snapshotVisibleFor } from './deleted-entries';
import { deleteServerEntry } from './server-delete';
import { bulkRetagUntagged, retagPendingEntry, retagServerEntry } from './attention-retag';
import { stableUserId } from '../auth-helpers';
import { buildOwnedCache, loadUserState, readOwnedServerSessions, readOwnedServerStats } from '../server-cache';
import type { BackgroundMessageContext } from './message-context';
import { resetEntrySync } from '../sync-policy';

// Caller must hold the storage lock
async function applyDeleteToStatsCache(
  snapshot: PendingEntry | undefined,
  context: BackgroundMessageContext
): Promise<unknown> {
  if (snapshot?.serverEntryId == null) return undefined;
  const deltaSeconds = (snapshot.duration_min || 0) * 60;
  if (deltaSeconds <= 0 || !snapshot.date) return undefined;
  const owner = stableUserId(await loadUserState());
  const envelope = await readOwnedServerStats(owner);
  if (!envelope || owner === null) return undefined;
  const cached = envelope.value as DecrementableServerStats;
  const settings = await context.loadSettings();
  const dsh = settings.dayStartHour || 0;
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const weekDays = getWeekDates(dsh);
  subtractSessionFromServerStats(
    cached, deltaSeconds,
    getLocalDateString(new Date(snapshot.date), dsh), getLocalDateString(new Date(), dsh),
    weekDays[0]?.date ?? '', weekDays[weekDays.length - 1]?.date ?? '', browserTz,
    snapshot.isPassive
  );
  return buildOwnedCache(owner, cached, envelope.cachedAt);
}

// Caller must hold the storage lock
async function stashAndSubtract(
  snapshot: PendingEntry | undefined,
  context: BackgroundMessageContext
): Promise<void> {
  if (!snapshot) return;
  const repeat = await hasDeletedSnapshot(snapshot.id, await currentUserId());
  const snapshots = await buildStashedSnapshots(snapshot);
  const cached = repeat ? undefined : await applyDeleteToStatsCache(snapshot, context);
  await browser.storage.local.set({
    [STORAGE_KEYS.DELETED_ENTRIES]: snapshots,
    ...(cached ? { [STORAGE_KEYS.CACHED_SERVER_STATS]: cached } : {})
  });
}

async function deletePendingById(
  entryId: string,
  entrySnapshot: PendingEntry | undefined,
  context: BackgroundMessageContext,
  blockedOnly = false
): Promise<{ success: boolean; data?: { remaining: number }; error?: string }> {
  const { deletedEntry, remaining, rejected } = await withStorageLock(async () => {
    const pending = await readSyncPending();
    const deletedEntry = pending.find(e => e.id === entryId);
    if (blockedOnly && (!deletedEntry || deletedEntry.synced || deletedEntry.syncState?.status !== 'blocked' || deletedEntry.serverEntryId != null)) {
      return { deletedEntry: undefined, remaining: pending.length, rejected: true };
    }
    await stashAndSubtract(deletedEntry ?? entrySnapshot, context);
    const filtered = pending.filter(e => e.id !== entryId);
    await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: filtered });
    updateBadge();
    return { deletedEntry, remaining: filtered.length, rejected: false };
  });
  if (rejected) return { success: false, error: 'Session changed. Review it again before removing.' };
  if (deletedEntry) await context.subtractFromStats(deletedEntry);
  return { success: true, data: { remaining } };
}

export async function handlePendingMessage(
  message: ExtensionMessage,
  context: BackgroundMessageContext
): Promise<unknown> {
  switch (message.type) {
    case 'GET_PENDING_ENTRIES': {
      void fetchAndCacheServerSessions();
      const pending = await loadPendingEntries();
      const owner = stableUserId(await loadUserState());
      const cached = await readOwnedServerSessions(owner);
      const serverSessions: CachedServerSession[] = cached?.value ?? [];
      if (serverSessions.length > 0) {
        const localServerIds = new Set(pending.filter(e => e.serverEntryId).map(e => String(e.serverEntryId)));
        const serverEntries: PendingEntry[] = serverSessions
          .filter(s => !localServerIds.has(String(s.id)))
          .map(s => ({
            id: `server-${s.id}`,
            date: s.date,
            duration_min: s.duration_min,
            project: s.title,
            project_id: s.project_id ?? '',
            platform: (s.platform || 'generic') as Platform,
            source: 'extension' as const,
            url: s.url || '',
            thumbnail: s.thumbnail || null,
            synced: true,
            syncedAt: s.date,
            syncAttempts: 0,
            lastSyncError: null,
            serverEntryId: typeof s.id === 'number' ? s.id : null,
            channelId: null,
            channelName: null,
            channelUrl: null,
            activityType: s.activityType as ActivityType | undefined,
          }));
        return { success: true, data: { entries: [...pending, ...serverEntries] } };
      }
      return { success: true, data: { entries: pending } };
    }

    case 'DELETE_PENDING_ENTRY': {
      if ('entryId' in message && typeof message.entryId === 'string') {
        return await deletePendingById(message.entryId, message.entrySnapshot, context);
      }
      return { success: false, error: 'No entryId provided' };
    }

    case 'REMOVE_BLOCKED_SYNC_ENTRY': {
      if (typeof message.entryId !== 'string') return { success: false, error: 'Invalid session' };
      return deletePendingById(message.entryId, undefined, context, true);
    }

    case 'DELETE_SERVER_ENTRY': {
      if (typeof message.serverEntryId !== 'number' || !message.entrySnapshot) {
        return { success: false, error: 'No serverEntryId provided' };
      }
      return await deleteServerEntry(message.serverEntryId, message.entrySnapshot);
    }

    case 'GET_DELETED_ENTRIES': {
      const snapshots = await loadDeletedSnapshots();
      const userId = await currentUserId();
      return { success: true, data: { entries: snapshots.filter(s => snapshotVisibleFor(s, userId)) } };
    }

    case 'RESTORE_DELETED_ENTRY': {
      if ('entryId' in message && typeof message.entryId === 'string') {
        const snapshot = await takeDeletedSnapshot(message.entryId);
        if (!snapshot) return { success: false, error: 'Entry not found' };
        if (!snapshotVisibleFor(snapshot, await currentUserId())) {
          try {
            await putDeletedSnapshot(snapshot);
          } catch { /* storage unavailable */ }
          return { success: false, error: 'Entry not found' };
        }
        const entry: PendingEntry = {
          ...snapshot.entry,
          synced: false,
          syncedAt: null,
          syncAttempts: 0,
          lastSyncError: null,
          serverEntryId: null
        };
        delete entry.syncState;
        let result: SavePendingResult = 'error';
        try {
          result = await context.savePendingEntry(entry, true);
        } catch { /* treated as error */ }
        if (result === 'error') {
          try {
            await putDeletedSnapshot(snapshot);
          } catch { /* storage unavailable */ }
          return { success: false, error: 'Could not restore entry' };
        }
        return { success: true };
      }
      return { success: false, error: 'No entryId provided' };
    }

    case 'PURGE_DELETED_ENTRY': {
      if ('entryId' in message && typeof message.entryId === 'string') {
        const snapshot = await takeDeletedSnapshot(message.entryId);
        if (!snapshot) return { success: false, error: 'Entry not found' };
        if (!snapshotVisibleFor(snapshot, await currentUserId())) {
          try {
            await putDeletedSnapshot(snapshot);
          } catch { /* storage unavailable */ }
          return { success: false, error: 'Entry not found' };
        }
        return { success: true };
      }
      return { success: false, error: 'No entryId provided' };
    }

    case 'CLEAR_SYNCED_ENTRIES': {
      return withStorageLock(async () => {
        const pending = await readSyncPending();
        const unsynced = pending.filter(e => !e.synced);
        await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: unsynced });
        updateBadge();
        return { success: true, data: { removed: pending.length - unsynced.length } };
      });
    }

    case 'UPDATE_PENDING_ENTRY_TITLE': {
      if ('entryId' in message && 'title' in message && typeof message.entryId === 'string' && typeof message.title === 'string' && message.title) {
        return withStorageLock(async () => {
          const pending = await readSyncPending();
          const updated = pending.map(e => {
            if (e.id === message.entryId) {
              const wasSent = e.synced || e.syncState?.everSent || e.syncAttempts > 0 || e.serverEntryId != null;
              const updated = { ...e, project: message.title as string };
              if (wasSent) {
                updated.synced = false;
                updated.syncedAt = null;
                updated.mergeResync = true;
              }
              resetEntrySync(updated);
              if (wasSent && updated.syncState) updated.syncState.everSent = true;
              return updated;
            }
            return e;
          });
          await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: updated });
          context.log('[JP343] Pending entry title updated:', message.title);
          return { success: true };
        });
      }
      return { success: false, error: 'No entryId or title provided' };
    }

    case 'RETAG_ENTRY': {
      if (!('isPassive' in message) || typeof message.isPassive !== 'boolean') {
        return { success: false, error: 'Invalid isPassive value' };
      }
      if ('serverEntryId' in message && message.serverEntryId != null) {
        return retagServerEntry(message.serverEntryId, message.isPassive);
      }
      if ('entryId' in message && typeof message.entryId === 'string' && message.entryId) {
        return retagPendingEntry(message.entryId, message.isPassive);
      }
      return { success: false, error: 'No entry reference provided' };
    }

    case 'BULK_RETAG_UNTAGGED': {
      if (!('isPassive' in message) || typeof message.isPassive !== 'boolean') {
        return { success: false, error: 'Invalid isPassive value' };
      }
      return bulkRetagUntagged(message.isPassive);
    }

    default:
      return { success: false, error: 'Unknown message type' };
  }
}
