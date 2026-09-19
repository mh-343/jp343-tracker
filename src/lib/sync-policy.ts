import type { PendingEntry } from '../types';
import { entryPayloadKey } from './entry-payload';

export const SYNC_RETRY_BASE_MS = 5 * 60_000;
export const SYNC_RETRY_MAX_MS = 60 * 60_000;
export const SYNC_DISPATCH_GAP_MS = 60_000;

export type SyncFailureKind = 'network' | 'server' | 'protocol' | 'auth' | 'input';

export interface EntrySyncState {
  version: 1;
  status: 'retry' | 'blocked';
  payloadKey: string;
  failures: number;
  lastAttemptAt: number;
  nextAttemptAt: number;
  errorCode: string | null;
  failureKind: SyncFailureKind | null;
  attemptId?: string;
  everSent?: boolean;
  rescued?: boolean;
}

export type SyncOutcome =
  | { kind: 'success'; entryId: number }
  | { kind: 'retry' | 'blocked' | 'auth'; code: string; failureKind: SyncFailureKind };

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function classifySyncResult(value: unknown, batch = false): SyncOutcome {
  const result = asRecord(value);
  const data = batch ? result : asRecord(result?.data);
  if (result?.success === true && Number.isSafeInteger(data?.entry_id) && Number(data?.entry_id) > 0) {
    return { kind: 'success', entryId: Number(data?.entry_id) };
  }
  const code = batch ? data?.error_code : data?.code;
  if (result?.success !== false || typeof code !== 'string') return protocolFailure();
  if (['invalid_token', 'invalid_nonce', 'E001', 'E002', 'E003'].includes(code)) {
    return { kind: 'auth', code, failureKind: 'auth' };
  }
  if (['E102', 'E103', 'E104'].includes(code)) {
    return { kind: 'blocked', code, failureKind: 'input' };
  }
  return { kind: 'retry', code: ['E200', 'E300'].includes(code) ? code : 'unknown_response', failureKind: 'server' };
}

export function protocolFailure(): SyncOutcome {
  return { kind: 'retry', code: 'invalid_response', failureKind: 'protocol' };
}

export function retryDelay(failures: number, random = Math.random()): number {
  const delay = Math.min(SYNC_RETRY_MAX_MS, SYNC_RETRY_BASE_MS * 2 ** Math.min(4, Math.max(0, failures - 1)));
  return Math.min(SYNC_RETRY_MAX_MS, Math.round(delay * (1 + Math.max(0, Math.min(1, random)) * 0.1)));
}

export function retryAfterTime(value: string | null, now: number): number {
  if (!value) return 0;
  const seconds = Number(value);
  const date = /^\d+(\.\d+)?$/.test(value.trim()) ? now + seconds * 1000 : Date.parse(value);
  return Number.isFinite(date) && date > now ? date : 0;
}

export function freshSyncState(entry: PendingEntry): EntrySyncState {
  return {
    version: 1, status: 'retry', payloadKey: entryPayloadKey(entry), failures: 0,
    lastAttemptAt: 0, nextAttemptAt: 0, errorCode: null, failureKind: null,
    everSent: entry.syncAttempts > 0 || entry.serverEntryId != null,
    rescued: !entry.synced && entry.syncAttempts >= 10
  };
}

export function resetEntrySync(entry: PendingEntry): void {
  const previous = entry.syncState;
  entry.syncState = {
    ...freshSyncState(entry), everSent: previous?.everSent || entry.syncAttempts > 0 || entry.serverEntryId != null,
    rescued: previous?.rescued ?? entry.syncAttempts >= 10,
    lastAttemptAt: previous?.lastAttemptAt ?? 0
  };
  entry.syncAttempts = 0;
  entry.lastSyncError = null;
}

export function normalizeEntrySync(entry: PendingEntry, now: number): boolean {
  if (entry.synced) return false;
  const state = entry.syncState;
  if (!state || state.version !== 1 || !['retry', 'blocked'].includes(state.status)) {
    entry.syncState = freshSyncState(entry);
    return true;
  }
  if (state.status === 'blocked' && (!['E102', 'E103', 'E104'].includes(state.errorCode ?? '') || state.failureKind !== 'input')) {
    resetEntrySync(entry);
    return true;
  }
  if (state.payloadKey !== entryPayloadKey(entry)) {
    resetEntrySync(entry);
    return true;
  }
  let changed = false;
  for (const key of ['failures', 'lastAttemptAt', 'nextAttemptAt'] as const) {
    if (!Number.isFinite(state[key]) || state[key] < 0) { state[key] = 0; changed = true; }
  }
  if (state.lastAttemptAt > now || state.nextAttemptAt > now + SYNC_RETRY_MAX_MS * 1.1) {
    state.lastAttemptAt = 0;
    state.nextAttemptAt = 0;
    changed = true;
  }
  return changed;
}

export function selectSyncEntries(entries: PendingEntry[], now: number, limit = 50): PendingEntry[] {
  return entries.filter(e => !e.synced && e.syncState?.status !== 'blocked' && (e.syncState?.nextAttemptAt ?? 0) <= now)
    .sort((a, b) => (a.syncState?.lastAttemptAt ?? 0) - (b.syncState?.lastAttemptAt ?? 0) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export function hasSyncIssue(entry: PendingEntry): boolean {
  return !entry.synced && !!(entry.lastSyncError || entry.syncState?.failureKind || entry.syncState?.rescued);
}
