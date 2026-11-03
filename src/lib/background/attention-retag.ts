import type { CachedServerSession, PendingEntry } from '../../types';
import { STORAGE_KEYS, activityAllowsPassive } from '../../types';
import { withStorageLock } from '../storage-lock';
import { loadPendingEntries } from '../pending-entries';
import { applyAttentionRetagToStats, attentionRetagBefore, type AttentionRetagMove } from './stats-managers';
import { hasAttentionCounters } from '../attention';
import { postJsonWithRetry } from '../server-fetch';
import {
  applyAuthParams,
  buildOwnedCache,
  captureServerRequestContext,
  isContextStillCurrent,
  readOwnedServerSessions,
  requestCredentialsMode
} from '../server-cache';
import { fetchAndCacheServerSessions } from '../server-sessions';
import { canonicalServerEntryId } from './server-delete';
import { resetEntrySync } from '../sync-policy';

export interface RetagResult {
  success: boolean;
  error?: string;
  updated?: number;
}

// measured entries keep counters, the retag is a choice
function needsRetag(entry: PendingEntry, isPassive: boolean): boolean {
  if (hasAttentionCounters(entry)) return entry.attentionChoice !== (isPassive ? 'passive' : 'active');
  return entry.isPassive !== isPassive;
}

function applyRetag(entry: PendingEntry, isPassive: boolean): void {
  entry.isPassive = isPassive;
  if (hasAttentionCounters(entry)) entry.attentionChoice = isPassive ? 'passive' : 'active';
}

export async function retagServerEntry(serverEntryId: number | string, isPassive: boolean): Promise<RetagResult> {
  const canonical = canonicalServerEntryId(serverEntryId);
  if (canonical === null) return { success: false, error: 'Invalid entry id' };
  const context = await captureServerRequestContext();
  if (!context) return { success: false, error: 'Not signed in' };
  const params = new URLSearchParams();
  applyAuthParams(params, context, {
    token: 'jp343_extension_retag_entry',
    nonce: 'jp343_retag_entry'
  });
  params.set('entry_id', canonical);
  params.set('is_passive', isPassive ? '1' : '0');
  const result = await postJsonWithRetry(context.ajaxUrl, params, 'retag_entry', {
    credentials: requestCredentialsMode(context)
  });
  if (!result?.success) {
    const message = typeof result?.data?.message === 'string' ? result.data.message : 'Retag failed';
    return { success: false, error: message };
  }
  await withStorageLock(async () => {
    if (!await isContextStillCurrent(context)) return;
    const patch: Record<string, unknown> = {};
    const pending = await loadPendingEntries();
    const moves: AttentionRetagMove[] = [];
    for (const entry of pending) {
      if (canonicalServerEntryId(entry.serverEntryId) === canonical && needsRetag(entry, isPassive)) {
        moves.push({ entry, before: attentionRetagBefore(entry) });
        applyRetag(entry, isPassive);
      }
    }
    if (moves.length > 0) patch[STORAGE_KEYS.PENDING] = pending;
    const sessions = await readOwnedServerSessions(context.ownerUserId);
    if (sessions) {
      let rowChanged = false;
      const rows = sessions.value.map((row: CachedServerSession) => {
        const target = isPassive ? 1 : 0;
        if (canonicalServerEntryId(row.id) !== canonical) return row;
        if (row.isPassive === isPassive && (row.passiveShare ?? target) === target) return row;
        rowChanged = true;
        return { ...row, isPassive, passiveShare: target };
      });
      if (rowChanged) {
        patch[STORAGE_KEYS.CACHED_SERVER_SESSIONS] = buildOwnedCache(context.ownerUserId, rows, sessions.cachedAt);
      }
    }
    if (Object.keys(patch).length > 0) await browser.storage.local.set(patch);
    await applyAttentionRetagToStats(moves);
  });
  return { success: true, updated: 1 };
}

export async function retagPendingEntry(entryId: string, isPassive: boolean): Promise<RetagResult> {
  const outcome = await withStorageLock(async (): Promise<
    { error: string } | { serverEntryId: number } | { done: true }
  > => {
    const pending = await loadPendingEntries();
    const entry = pending.find(e => e.id === entryId);
    if (!entry) return { error: 'Entry not found' };
    if (isPassive && !activityAllowsPassive(entry.activityType)) {
      return { error: 'Reading and speaking entries count as active' };
    }
    if (entry.synced && entry.serverEntryId != null) {
      return { serverEntryId: entry.serverEntryId };
    }
    const changed = needsRetag(entry, isPassive);
    const before = attentionRetagBefore(entry);
    applyRetag(entry, isPassive);
    if (!entry.synced && changed) {
      if (entry.syncState?.everSent || entry.syncAttempts > 0 || entry.serverEntryId != null) entry.mergeResync = true;
      resetEntrySync(entry);
    }
    await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: pending });
    if (changed) {
      await applyAttentionRetagToStats([{ entry, before }]);
    }
    return { done: true };
  });
  if ('error' in outcome) return { success: false, error: outcome.error };
  if ('serverEntryId' in outcome) return retagServerEntry(outcome.serverEntryId, isPassive);
  return { success: true, updated: 1 };
}

export async function bulkRetagUntagged(isPassive: boolean): Promise<RetagResult> {
  const context = await captureServerRequestContext();
  let serverUpdated: number | undefined;
  if (context) {
    const params = new URLSearchParams();
    applyAuthParams(params, context, {
      token: 'jp343_extension_retag_untagged',
      nonce: 'jp343_retag_untagged'
    });
    params.set('is_passive', isPassive ? '1' : '0');
    params.set('scope', 'all');
    const result = await postJsonWithRetry(context.ajaxUrl, params, 'retag_untagged', {
      credentials: requestCredentialsMode(context)
    });
    if (!result?.success) {
      const message = typeof result?.data?.message === 'string' ? result.data.message : 'Bulk retag failed';
      return { success: false, error: message };
    }
    serverUpdated = typeof result.data?.updated === 'number' ? result.data.updated : undefined;
  }
  const localUpdated = await withStorageLock(async () => {
    if (context && !await isContextStillCurrent(context)) return 0;
    const pending = await loadPendingEntries();
    const moves: AttentionRetagMove[] = [];
    for (const entry of pending) {
      if (entry.isPassive !== undefined) continue;
      if (isPassive && !activityAllowsPassive(entry.activityType)) continue;
      moves.push({ entry, before: attentionRetagBefore(entry) });
      applyRetag(entry, isPassive);
      if (!entry.synced) {
        if (entry.syncState?.everSent || entry.syncAttempts > 0 || entry.serverEntryId != null) entry.mergeResync = true;
        resetEntrySync(entry);
      }
    }
    if (moves.length > 0) {
      await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: pending });
      await applyAttentionRetagToStats(moves);
    }
    return moves.length;
  });
  if (context) void fetchAndCacheServerSessions(true);
  return { success: true, updated: serverUpdated ?? localUpdated };
}
