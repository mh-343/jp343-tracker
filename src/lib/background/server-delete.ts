import {
  STORAGE_KEYS,
  type CachedServerSession,
  type ExtensionSettings,
  type PendingEntry,
  type ServerDeleteRecord,
  type ServerDeleteRecordMap
} from '../../types';
import { isStableUserId, stableUserId } from '../auth-helpers';
import { withStorageLock } from '../storage-lock';
import { loadPendingEntries } from '../pending-entries';
import { getLocalDateString, getWeekDates } from '../format-utils';
import { subtractSessionFromServerStats, type DecrementableServerStats } from '../server-stats';
import { postJsonWithRetry } from '../server-fetch';
import {
  applyAuthParams,
  buildOwnedCache,
  captureServerRequestContext,
  loadUserState,
  readOwnedServerSessions,
  readOwnedServerStats,
  readServerCacheEpoch,
  requestCredentialsMode,
  type ServerRequestContext
} from '../server-cache';
import { buildStashedSnapshots } from './deleted-entries';
import { buildStatsAfterSubtraction } from './stats-managers';
import { updateBadge } from '../badge-service';

export const DELETE_RECORD_SCHEMA_VERSION = 1;
const MAX_UNCONFIRMED_RECORDS = 500;
const MAX_UNCONFIRMED_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function canonicalServerEntryId(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  return /^\d+$/.test(value) && Number(value) > 0 ? value : null;
}

export function deleteRecordKey(ownerUserId: number, serverEntryId: string): string | null {
  if (!isStableUserId(ownerUserId)) return null;
  const canonical = canonicalServerEntryId(serverEntryId);
  return canonical === null ? null : `${ownerUserId}:${canonical}`;
}

export function createDeleteRecord(
  intentId: string,
  ownerUserId: number,
  serverEntryId: string,
  snapshot: PendingEntry,
  now: number
): ServerDeleteRecord {
  return {
    schemaVersion: DELETE_RECORD_SCHEMA_VERSION,
    intentId,
    ownerUserId,
    serverEntryId,
    createdAt: now,
    confirmedAt: null,
    appliedAt: null,
    snapshot
  };
}

export function isDeleteRecord(value: unknown): value is ServerDeleteRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== DELETE_RECORD_SCHEMA_VERSION) return false;
  if (typeof record.intentId !== 'string' || !record.intentId) return false;
  if (!isStableUserId(record.ownerUserId)) return false;
  if (canonicalServerEntryId(record.serverEntryId) === null) return false;
  if (record.confirmedAt !== null && typeof record.confirmedAt !== 'number') return false;
  if (record.appliedAt !== null && typeof record.appliedAt !== 'number') return false;
  return typeof record.snapshot === 'object' && record.snapshot !== null;
}

export function parseDeleteRecords(raw: unknown): ServerDeleteRecordMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const parsed: ServerDeleteRecordMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isDeleteRecord(value)) parsed[key] = value;
  }
  return parsed;
}

export function pruneDeleteRecords(records: ServerDeleteRecordMap, now: number): ServerDeleteRecordMap {
  const settled: [string, ServerDeleteRecord][] = [];
  const unconfirmed: [string, ServerDeleteRecord][] = [];
  for (const entry of Object.entries(records)) {
    const record = entry[1];
    if (record.confirmedAt !== null || record.appliedAt !== null) settled.push(entry);
    else if (now - record.createdAt <= MAX_UNCONFIRMED_AGE_MS) unconfirmed.push(entry);
  }
  unconfirmed.sort((a, b) => b[1].createdAt - a[1].createdAt);
  return Object.fromEntries([...settled, ...unconfirmed.slice(0, MAX_UNCONFIRMED_RECORDS)]);
}

export async function loadDeleteRecords(): Promise<ServerDeleteRecordMap> {
  const res = await browser.storage.local.get(STORAGE_KEYS.SERVER_DELETE_RECORDS);
  return parseDeleteRecords(res[STORAGE_KEYS.SERVER_DELETE_RECORDS]);
}

export interface ServerDeleteDeps {
  loadSettings: () => Promise<ExtensionSettings>;
  log: (...args: unknown[]) => void;
}

let deps: ServerDeleteDeps = {
  loadSettings: () => Promise.reject(new Error('not initialized')),
  log: () => {}
};

export function initServerDelete(next: ServerDeleteDeps): void {
  deps = next;
}

export interface ServerDeleteResult {
  success: boolean;
  applied: boolean;
  error?: string;
}

async function credentialsStillBound(context: ServerRequestContext): Promise<boolean> {
  const userState = await loadUserState();
  if (stableUserId(userState) !== context.ownerUserId) return false;
  const live = context.credentialKind === 'token' ? userState?.extApiToken : userState?.nonce;
  return live === context.credential;
}

async function requestServerDelete(context: ServerRequestContext, serverEntryId: string): Promise<boolean> {
  const params = new URLSearchParams();
  applyAuthParams(params, context, {
    token: 'jp343_extension_delete_time_entry',
    nonce: 'jp343_delete_time_entry'
  });
  params.set('entry_id', serverEntryId);
  const result = await postJsonWithRetry(context.ajaxUrl, params, 'delete_time_entry', {
    credentials: requestCredentialsMode(context)
  });
  return result?.success === true;
}

// Caller must hold the storage lock
async function persistRecords(records: ServerDeleteRecordMap, now: number): Promise<void> {
  await browser.storage.local.set({
    [STORAGE_KEYS.SERVER_DELETE_RECORDS]: pruneDeleteRecords(records, now)
  });
}

interface PreparedDelete {
  context: ServerRequestContext;
  key: string;
  record: ServerDeleteRecord;
  alreadyApplied: boolean;
  alreadyConfirmed: boolean;
}

async function prepareDelete(
  serverEntryId: string,
  snapshot: PendingEntry
): Promise<PreparedDelete | null> {
  return await withStorageLock(async () => {
    const context = await captureServerRequestContext();
    if (!context) return null;
    const key = deleteRecordKey(context.ownerUserId, serverEntryId);
    if (key === null) return null;

    const snapshotId = canonicalServerEntryId(snapshot.serverEntryId);
    if (snapshotId !== null && snapshotId !== serverEntryId) return null;

    const records = await loadDeleteRecords();
    const existing = records[key];
    if (existing) {
      return {
        context,
        key,
        record: existing,
        alreadyApplied: existing.appliedAt !== null,
        alreadyConfirmed: existing.confirmedAt !== null
      };
    }

    const now = Date.now();
    const record = createDeleteRecord(
      `del_${crypto.randomUUID()}`,
      context.ownerUserId,
      serverEntryId,
      snapshot,
      now
    );
    records[key] = record;
    await persistRecords(records, now);
    return { context, key, record, alreadyApplied: false, alreadyConfirmed: false };
  });
}

async function markConfirmed(key: string): Promise<void> {
  await withStorageLock(async () => {
    const records = await loadDeleteRecords();
    const record = records[key];
    if (!record || record.confirmedAt !== null) return;
    records[key] = { ...record, confirmedAt: Date.now() };
    await persistRecords(records, Date.now());
  });
}

function serverStatsAfterDelete(
  cached: DecrementableServerStats,
  snapshot: PendingEntry,
  dayStartHour: number
): DecrementableServerStats {
  const deltaSeconds = (snapshot.duration_min || 0) * 60;
  if (deltaSeconds <= 0 || !snapshot.date) return cached;
  const weekDays = getWeekDates(dayStartHour);
  subtractSessionFromServerStats(
    cached,
    deltaSeconds,
    getLocalDateString(new Date(snapshot.date), dayStartHour),
    getLocalDateString(new Date(), dayStartHour),
    weekDays[0]?.date ?? '',
    weekDays[weekDays.length - 1]?.date ?? '',
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    snapshot.isPassive
  );
  return cached;
}

export async function applyConfirmedDelete(key: string): Promise<boolean> {
  return await withStorageLock(async () => {
    const records = await loadDeleteRecords();
    const record = records[key];
    if (!record || record.confirmedAt === null) return false;

    const owner = stableUserId(await loadUserState());
    if (owner !== record.ownerUserId) return false;

    const pending = await loadPendingEntries();
    const localMatch = pending.find(e => canonicalServerEntryId(e.serverEntryId) === record.serverEntryId);
    const patch: Record<string, unknown> = {};

    if (record.appliedAt === null) {
      const source = localMatch ?? record.snapshot;
      patch[STORAGE_KEYS.DELETED_ENTRIES] = await buildStashedSnapshots(source);
      if (localMatch) {
        const stats = await buildStatsAfterSubtraction(localMatch);
        if (stats) patch[STORAGE_KEYS.STATS] = stats;
      }
      const settings = await deps.loadSettings();
      const cached = await readOwnedServerStats(owner);
      if (cached) {
        const value = serverStatsAfterDelete(
          cached.value as DecrementableServerStats,
          record.snapshot,
          settings.dayStartHour || 0
        );
        patch[STORAGE_KEYS.CACHED_SERVER_STATS] = buildOwnedCache(owner, value, cached.cachedAt);
      }
    }

    if (localMatch) {
      patch[STORAGE_KEYS.PENDING] = pending.filter(
        e => canonicalServerEntryId(e.serverEntryId) !== record.serverEntryId
      );
    }

    const sessions = await readOwnedServerSessions(owner);
    if (sessions) {
      const filtered = sessions.value.filter(
        (s: CachedServerSession) => canonicalServerEntryId(s.id) !== record.serverEntryId
      );
      if (filtered.length !== sessions.value.length) {
        patch[STORAGE_KEYS.CACHED_SERVER_SESSIONS] = buildOwnedCache(owner, filtered, sessions.cachedAt);
      }
    }

    const firstApply = record.appliedAt === null;
    const changedData = firstApply || Object.keys(patch).length > 0;
    records[key] = { ...record, appliedAt: record.appliedAt ?? Date.now() };
    patch[STORAGE_KEYS.SERVER_DELETE_RECORDS] = pruneDeleteRecords(records, Date.now());
    if (changedData) patch[STORAGE_KEYS.SERVER_CACHE_EPOCH] = await readServerCacheEpoch() + 1;

    await browser.storage.local.set(patch);
    updateBadge();
    return true;
  });
}

export async function deleteServerEntry(
  serverEntryId: number,
  snapshot: PendingEntry
): Promise<ServerDeleteResult> {
  const canonical = canonicalServerEntryId(serverEntryId);
  if (canonical === null) return { success: false, applied: false, error: 'Invalid server entry id' };

  const prepared = await prepareDelete(canonical, snapshot);
  if (!prepared) return { success: false, applied: false, error: 'No usable auth' };

  if (prepared.alreadyApplied) {
    const applied = await applyConfirmedDelete(prepared.key);
    return { success: true, applied };
  }

  if (!prepared.alreadyConfirmed) {
    if (!await credentialsStillBound(prepared.context)) {
      return { success: false, applied: false, error: 'Owner changed before request' };
    }
    if (!await requestServerDelete(prepared.context, canonical)) {
      return { success: false, applied: false, error: 'Server delete not confirmed' };
    }
    await markConfirmed(prepared.key);
  }

  const applied = await applyConfirmedDelete(prepared.key);
  return { success: true, applied };
}

export async function reconcileConfirmedDeletes(): Promise<void> {
  const owner = stableUserId(await loadUserState());
  if (owner === null) return;
  const records = await loadDeleteRecords();
  for (const [key, record] of Object.entries(records)) {
    if (record.ownerUserId !== owner) continue;
    if (record.confirmedAt === null || record.appliedAt !== null) continue;
    await applyConfirmedDelete(key).catch(error => deps.log('[JP343] Delete reconcile failed:', error));
  }
}
