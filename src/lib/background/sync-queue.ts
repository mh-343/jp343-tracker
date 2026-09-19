import type { PendingEntry, Platform, ExtensionSettings } from '../../types';
import { STORAGE_KEYS, PLATFORM_ACTIVITY_TYPE } from '../../types';
import { withStorageLock } from '../storage-lock';
import { entryPayloadKey } from '../entry-payload';
import { asRecord, freshSyncState, normalizeEntrySync, selectSyncEntries, retryDelay, SYNC_DISPATCH_GAP_MS, SYNC_RETRY_BASE_MS } from '../sync-policy';
import type { SyncOutcome } from '../sync-policy';
import { isContextStillCurrent, type ServerRequestContext } from '../server-cache';

export type SyncMetric = 'sync_legacy_stranded' | 'sync_legacy_recovered' | 'sync_entry_blocked';
export type SyncCounts = Partial<Record<Platform, Partial<Record<SyncMetric, number>>>>;

export interface SyncQueueState {
  version: 1;
  notBefore: number;
  serverNotBefore: number;
  updatedAt: number;
  singleUntil: number;
  counts: SyncCounts;
}

export interface SyncAttempt {
  entry: PendingEntry;
  previous: PendingEntry;
  attemptId: string;
}

export async function syncDiagnosticsAllowed(): Promise<boolean> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
  const settings = stored[STORAGE_KEYS.SETTINGS] as ExtensionSettings | undefined;
  if (settings?.diagnosticsEnabled === false) return false;
  try {
    const permissions = await browser.permissions.getAll() as { data_collection?: string[] };
    return !permissions.data_collection || permissions.data_collection.includes('technicalAndInteraction');
  } catch { return true; }
}

export async function readSyncQueue(): Promise<SyncQueueState> {
  const raw = asRecord((await browser.storage.local.get(STORAGE_KEYS.SYNC_QUEUE))[STORAGE_KEYS.SYNC_QUEUE]);
  const counts: SyncCounts = {};
  const storedCounts = asRecord(raw?.counts);
  for (const platform of Object.keys(PLATFORM_ACTIVITY_TYPE) as Platform[]) {
    const values = asRecord(storedCounts?.[platform]);
    for (const metric of ['sync_legacy_stranded', 'sync_legacy_recovered', 'sync_entry_blocked'] as const) {
      const value = values?.[metric];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
        (counts[platform] ?? (counts[platform] = {}))[metric] = value;
      }
    }
  }
  const timestamp = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  return {
    version: 1, notBefore: timestamp(raw?.notBefore), serverNotBefore: timestamp(raw?.serverNotBefore),
    updatedAt: timestamp(raw?.updatedAt), singleUntil: timestamp(raw?.singleUntil), counts
  };
}

export async function readSyncPending(): Promise<PendingEntry[]> {
  const raw = (await browser.storage.local.get(STORAGE_KEYS.PENDING))[STORAGE_KEYS.PENDING];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('Pending storage is unavailable');
  return raw as PendingEntry[];
}

function countEvent(state: SyncQueueState, platform: Platform, metric: SyncMetric): void {
  if (!(platform in PLATFORM_ACTIVITY_TYPE)) return;
  const counts = state.counts[platform] ?? (state.counts[platform] = {});
  counts[metric] = Math.min(Number.MAX_SAFE_INTEGER, (counts[metric] ?? 0) + 1);
}

async function normalizeQueue(pending: PendingEntry[], state: SyncQueueState, now: number): Promise<void> {
  const allowed = await syncDiagnosticsAllowed();
  if (!allowed) state.counts = {};
  for (const entry of pending) {
    const legacy = !entry.synced && entry.syncState?.version !== 1 && entry.syncAttempts >= 10;
    normalizeEntrySync(entry, now);
    if (legacy && allowed) countEvent(state, entry.platform, 'sync_legacy_stranded');
  }
  if (state.updatedAt > now) {
    state.notBefore = 0;
    state.serverNotBefore = 0;
    state.singleUntil = 0;
  }
}

async function writeQueue(pending: PendingEntry[], state: SyncQueueState, before?: string): Promise<void> {
  if (before === JSON.stringify([pending, state])) return;
  await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: pending, [STORAGE_KEYS.SYNC_QUEUE]: state });
}

export async function prepareSyncQueue(): Promise<void> {
  await withStorageLock(async () => {
    const pending = await readSyncPending();
    const state = await readSyncQueue();
    const before = JSON.stringify([pending, state]);
    await normalizeQueue(pending, state, Date.now());
    await writeQueue(pending, state, before);
  });
}

export async function reserveSyncAttempts(context: ServerRequestContext, internal = false): Promise<{ attempts: SyncAttempt[]; single: boolean; deferredUntil: number }> {
  return withStorageLock(async () => {
    const now = Date.now();
    const pending = await readSyncPending();
    const state = await readSyncQueue();
    const before = JSON.stringify([pending, state]);
    await normalizeQueue(pending, state, now);
    const single = state.singleUntil > now;
    const deferredUntil = Math.max(state.serverNotBefore, internal ? 0 : state.notBefore);
    const selected = deferredUntil > now || !await isContextStillCurrent(context) ? [] : selectSyncEntries(pending, now, single ? 3 : 50);
    const attempts = selected.map(entry => {
      const previous = structuredClone(entry);
      const attemptId = crypto.randomUUID();
      const sync = entry.syncState ?? freshSyncState(entry);
      entry.syncState = { ...sync, attemptId, everSent: true, lastAttemptAt: now, nextAttemptAt: now + SYNC_RETRY_BASE_MS };
      return { entry: structuredClone(entry), previous, attemptId };
    });
    if (attempts.length) { state.notBefore = now + SYNC_DISPATCH_GAP_MS; state.updatedAt = now; }
    await writeQueue(pending, state, before);
    return { attempts, single, deferredUntil };
  });
}

export async function markBatchUnavailable(attempts: SyncAttempt[], context: ServerRequestContext): Promise<void> {
  await releaseSyncAttempts(attempts, context, true);
}

export async function releaseSyncAttempts(attempts: SyncAttempt[], context: ServerRequestContext, single = false): Promise<void> {
  await withStorageLock(async () => {
    if (!await isContextStillCurrent(context)) return;
    const pending = await readSyncPending();
    const byId = new Map(attempts.map(a => [a.entry.id, a]));
    for (const entry of pending) {
      const attempt = byId.get(entry.id);
      if (attempt && entry.syncState?.attemptId === attempt.attemptId && entryPayloadKey(entry) === entryPayloadKey(attempt.entry)) {
        entry.syncState = attempt.previous.syncState;
      }
    }
    const state = await readSyncQueue();
    if (single) state.singleUntil = Date.now() + 24 * 60 * 60_000;
    await writeQueue(pending, state);
  });
}

export async function applySyncOutcomes(
  attempts: SyncAttempt[], outcomes: Map<string, SyncOutcome>, context: ServerRequestContext, serverNotBefore = 0
): Promise<{ succeeded: number; failed: number }> {
  return withStorageLock(async () => {
    if (!await isContextStillCurrent(context)) return { succeeded: 0, failed: 0 };
    const pending = await readSyncPending();
    const state = await readSyncQueue();
    const allowed = await syncDiagnosticsAllowed();
    if (!allowed) state.counts = {};
    state.serverNotBefore = Math.max(state.serverNotBefore, serverNotBefore);
    state.updatedAt = Date.now();
    let succeeded = 0;
    let failed = 0;
    const byId = new Map(attempts.map(a => [a.entry.id, a]));
    for (const entry of pending) {
      const attempt = byId.get(entry.id);
      const outcome = outcomes.get(entry.id);
      if (!attempt || !outcome || entry.synced || entry.syncState?.attemptId !== attempt.attemptId) continue;
      if (entryPayloadKey(entry) !== entryPayloadKey(attempt.entry)) continue;
      const sync = entry.syncState;
      if (outcome.kind === 'success') {
        entry.synced = true;
        entry.syncedAt = new Date().toISOString();
        entry.serverEntryId = outcome.entryId;
        entry.mergeResync = false;
        entry.lastSyncError = null;
        entry.syncAttempts = 0;
        if (sync.rescued && allowed) countEvent(state, entry.platform, 'sync_legacy_recovered');
        delete entry.syncState;
        succeeded++;
      } else {
        sync.status = outcome.kind === 'blocked' ? 'blocked' : 'retry';
        sync.failureKind = outcome.failureKind;
        sync.errorCode = outcome.code;
        sync.failures = outcome.kind === 'auth' ? sync.failures : Math.min(100, sync.failures + 1);
        sync.nextAttemptAt = Date.now() + retryDelay(sync.failures);
        entry.syncAttempts = Math.min(9, sync.failures);
        entry.lastSyncError = outcome.code;
        if (outcome.kind === 'blocked' && allowed) countEvent(state, entry.platform, 'sync_entry_blocked');
        failed++;
      }
    }
    await writeQueue(pending, state);
    return { succeeded, failed };
  });
}

export async function retryPendingSync(entryIds?: string[]): Promise<void> {
  await withStorageLock(async () => {
    const pending = await readSyncPending();
    const state = await readSyncQueue();
    await normalizeQueue(pending, state, Date.now());
    const ids = entryIds ? new Set(entryIds) : null;
    for (const entry of pending) {
      if (!entry.synced && entry.syncState?.status === 'retry' && (!ids || ids.has(entry.id))) entry.syncState.nextAttemptAt = 0;
    }
    await writeQueue(pending, state);
  });
}

export async function acknowledgeSyncCounts(sent: SyncCounts): Promise<void> {
  await withStorageLock(async () => {
    const state = await readSyncQueue();
    if (!await syncDiagnosticsAllowed()) state.counts = {};
    else for (const platform of Object.keys(sent) as Platform[]) {
      for (const metric of Object.keys(sent[platform] ?? {}) as SyncMetric[]) {
        const counts = state.counts[platform];
        if (counts) counts[metric] = Math.max(0, (counts[metric] ?? 0) - (sent[platform]?.[metric] ?? 0));
      }
    }
    await browser.storage.local.set({ [STORAGE_KEYS.SYNC_QUEUE]: state });
  });
}
