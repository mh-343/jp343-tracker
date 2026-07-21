import type { ExtensionMessage, PendingEntry, CachedServerSession, Platform, ActivityType, SavePendingResult } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { updateBadge } from '../badge-service';
import { loadPendingEntries } from '../pending-entries';
import { fetchAndCacheServerSessions } from '../server-sessions';
import { withStorageLock } from '../storage-lock';
import { getLocalDateString, getWeekDates } from '../format-utils';
import { subtractSessionFromServerStats, type DecrementableServerStats } from '../server-stats';
import { loadDeletedSnapshots, stashDeletedEntry, takeDeletedSnapshot, putDeletedSnapshot, currentUserId, snapshotVisibleFor } from './deleted-entries';
import type { BackgroundMessageContext } from './message-context';

async function applyDeleteToStatsCache(
  snapshot: PendingEntry | undefined,
  context: BackgroundMessageContext
): Promise<void> {
  if (snapshot?.serverEntryId == null) return;
  const deltaSeconds = (snapshot.duration_min || 0) * 60;
  if (deltaSeconds <= 0 || !snapshot.date) return;
  await withStorageLock(async () => {
    const stored = await browser.storage.local.get(STORAGE_KEYS.CACHED_SERVER_STATS);
    const cached = stored[STORAGE_KEYS.CACHED_SERVER_STATS] as DecrementableServerStats | undefined;
    if (!cached) return;
    const settings = await context.loadSettings();
    const dsh = settings.dayStartHour || 0;
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const weekDays = getWeekDates(dsh);
    subtractSessionFromServerStats(
      cached, deltaSeconds,
      getLocalDateString(new Date(snapshot.date), dsh), getLocalDateString(new Date(), dsh),
      weekDays[0]?.date ?? '', weekDays[weekDays.length - 1]?.date ?? '', browserTz
    );
    await browser.storage.local.set({ [STORAGE_KEYS.CACHED_SERVER_STATS]: cached });
  });
}

async function deletePendingById(
  entryId: string,
  entrySnapshot: PendingEntry | undefined,
  context: BackgroundMessageContext
): Promise<{ success: boolean; data: { remaining: number } }> {
  const { deletedEntry, snapshot, remaining } = await withStorageLock(async () => {
    const pending = await loadPendingEntries();
    const deletedEntry = pending.find(e => e.id === entryId);
    const snapshot = deletedEntry ?? entrySnapshot;
    if (snapshot) await stashDeletedEntry(snapshot);
    const filtered = pending.filter(e => e.id !== entryId);
    await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: filtered });
    updateBadge();
    return { deletedEntry, snapshot, remaining: filtered.length };
  });
  if (deletedEntry) await context.subtractFromStats(deletedEntry);
  await applyDeleteToStatsCache(snapshot, context);
  return { success: true, data: { remaining } };
}

async function deleteByServerId(
  serverEntryId: number,
  entrySnapshot: PendingEntry | undefined,
  context: BackgroundMessageContext
): Promise<{ success: boolean; data: { found: boolean } }> {
  const { match, snapshot, found } = await withStorageLock(async () => {
    const pending = await loadPendingEntries();
    const match = pending.find(e => e.serverEntryId === serverEntryId);
    const snapshot = match ?? entrySnapshot;
    if (snapshot) await stashDeletedEntry(snapshot);
    if (!match) return { match: undefined, snapshot, found: false };
    const filtered = pending.filter(e => e.serverEntryId !== serverEntryId);
    await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: filtered });
    updateBadge();
    return { match, snapshot, found: true };
  });
  if (match) await context.subtractFromStats(match);
  await applyDeleteToStatsCache(snapshot, context);
  return { success: true, data: { found } };
}

export async function handlePendingMessage(
  message: ExtensionMessage,
  context: BackgroundMessageContext
): Promise<unknown> {
  switch (message.type) {
    case 'GET_PENDING_ENTRIES': {
      void fetchAndCacheServerSessions();
      const pending = await loadPendingEntries();
      const cached = await browser.storage.local.get(STORAGE_KEYS.CACHED_SERVER_SESSIONS);
      const serverSessions: CachedServerSession[] = cached[STORAGE_KEYS.CACHED_SERVER_SESSIONS] || [];
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

    case 'DELETE_PENDING_BY_SERVER_ID': {
      if ('serverEntryId' in message && typeof message.serverEntryId === 'number') {
        return await deleteByServerId(message.serverEntryId, message.entrySnapshot, context);
      }
      return { success: false, error: 'No serverEntryId provided' };
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
        let result: SavePendingResult = 'error';
        try {
          result = await context.savePendingEntry(entry);
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
        const pending = await loadPendingEntries();
        const unsynced = pending.filter(e => !e.synced);
        await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: unsynced });
        updateBadge();
        return { success: true, data: { removed: pending.length - unsynced.length } };
      });
    }

    case 'UPDATE_PENDING_ENTRY_TITLE': {
      if ('entryId' in message && 'title' in message && typeof message.entryId === 'string' && typeof message.title === 'string' && message.title) {
        return withStorageLock(async () => {
          const pending = await loadPendingEntries();
          const updated = pending.map(e => {
            if (e.id === message.entryId) {
              return { ...e, project: message.title as string, syncAttempts: 0, lastSyncError: null };
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

    default:
      return { success: false, error: 'Unknown message type' };
  }
}
