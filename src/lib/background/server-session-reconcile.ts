import type { CachedServerSession, ExtensionSettings, ExtensionStats, PendingEntry } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { withStorageLock } from '../storage-lock';
import { readSyncPending } from './sync-queue';
import { stableUserId } from '../auth-helpers';
import { loadUserState, readOwnedServerSessions } from '../server-cache';
import { canonicalServerEntryId } from './server-delete';
import { applyStatsSubtraction, loadStats } from './stats-managers';
import { withStatsUpdate } from './stats-snapshot';
import { updateBadge } from '../badge-service';

const RECENT_SESSIONS_REQUEST_LIMIT = 20;

// logged_at from the server has no timezone; parse naive
// timestamps as UTC so they line up with the entry's ISO date.
function parseServerTime(value: string): number {
  const hasZone = /[zZ]$|[+-]\d\d:?\d\d$/.test(value);
  return Date.parse(value.includes('T') && !hasZone ? value + 'Z' : value);
}

interface ServerSessionReconcileDeps {
  log: (...args: unknown[]) => void;
  loadSettings: () => Promise<ExtensionSettings>;
}

let deps: ServerSessionReconcileDeps = {
  log: () => {},
  loadSettings: () => Promise.reject(new Error('not initialized')),
};

export function initServerSessionReconcile(next: ServerSessionReconcileDeps): void {
  deps = next;
}

// A synced entry missing from the fetched session cache was
// deleted on the website. The cache holds only the newest
// `requestLimit` rows by logged_at, so treat a miss as a
// delete only when conclusive: cache non-empty, entry not
// below the fetched window (bounded when limit-capped), and
// synced before the request (would be in the snapshot).
export function selectServerDeletedEntries(
  pending: PendingEntry[],
  sessions: CachedServerSession[],
  requestedAt: number,
  requestLimit: number
): PendingEntry[] {
  if (sessions.length === 0) return [];

  const presentIds = new Set<string>();
  const times: number[] = [];
  for (const session of sessions) {
    const id = canonicalServerEntryId(session.id);
    if (id !== null) presentIds.add(id);
    const time = parseServerTime(session.date);
    if (Number.isFinite(time)) times.push(time);
  }
  if (times.length === 0) return [];

  const windowMin = sessions.length >= requestLimit ? Math.min(...times) : Number.NEGATIVE_INFINITY;

  return pending.filter(entry => {
    if (!entry.synced) return false;
    const id = canonicalServerEntryId(entry.serverEntryId);
    if (id === null || presentIds.has(id)) return false;

    const loggedAt = parseServerTime(entry.date);
    if (!Number.isFinite(loggedAt) || loggedAt <= windowMin) return false;

    if (!entry.syncedAt) return false;
    const syncedAt = parseServerTime(entry.syncedAt);
    if (!Number.isFinite(syncedAt) || syncedAt >= requestedAt) return false;
    return true;
  });
}

export async function reconcileDeletedServerEntries(requestedAt: number): Promise<void> {
  await withStorageLock(async () => {
    try {
      const owner = stableUserId(await loadUserState());
      if (owner === null) return;
      const envelope = await readOwnedServerSessions(owner);
      if (!envelope || envelope.value.length === 0) return;

      const pending = await readSyncPending();
      const deleted = selectServerDeletedEntries(
        pending,
        envelope.value,
        requestedAt,
        RECENT_SESSIONS_REQUEST_LIMIT
      );
      if (deleted.length === 0) return;

      const settings = await deps.loadSettings();
      const dayStartHour = settings.dayStartHour || 0;
      const deletedIds = new Set(
        deleted
          .map(entry => canonicalServerEntryId(entry.serverEntryId))
          .filter((id): id is string => id !== null)
      );

      await withStatsUpdate(async () => {
        let stats: ExtensionStats = await loadStats();
        for (const entry of deleted) {
          stats = applyStatsSubtraction(stats, entry, dayStartHour);
        }
        const remaining = pending.filter(entry => {
          const id = canonicalServerEntryId(entry.serverEntryId);
          return id === null || !deletedIds.has(id);
        });
        await browser.storage.local.set({
          [STORAGE_KEYS.STATS]: stats,
          [STORAGE_KEYS.PENDING]: remaining,
        });
      });
      updateBadge();
      deps.log('[JP343] Reconciled ' + deleted.length + ' server-deleted entr' + (deleted.length === 1 ? 'y' : 'ies'));
    } catch (error) {
      deps.log('[JP343] Server-delete reconcile failed:', error);
    }
  });
}
