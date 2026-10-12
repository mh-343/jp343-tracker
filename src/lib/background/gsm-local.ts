import type { PendingEntry } from '../../types';
import { STORAGE_KEYS } from '../../types';
import type { GsmLocalContext, GsmLocalDiff, GsmLocalStore, GsmStoreDiff } from '../gsm/local-mirror';
import { applyServerResult, gsmViewEntries, reconcileLocalDays, setGsmLocalState, toGsmLocalStore } from '../gsm/local-mirror';
import type { PlannedDay } from '../gsm/payload';
import { withStorageLock } from '../storage-lock';
import { buildStashedSnapshots } from './deleted-entries';
import { applyStatsAddition, applyStatsSubtraction, loadStats } from './stats-managers';
import { withStatsUpdate } from './stats-snapshot';

export async function loadGsmLocalStore(): Promise<GsmLocalStore> {
  return toGsmLocalStore((await browser.storage.local.get(STORAGE_KEYS.GSM_LOCAL))[STORAGE_KEYS.GSM_LOCAL]);
}

// one lock, one write: the store and the stats together
export async function commitGsmStore<S>(
  key: string,
  load: () => Promise<S>,
  dayStartHour: number,
  change: (store: S) => GsmStoreDiff<S> | null | Promise<GsmStoreDiff<S> | null>,
  extra?: (diff: GsmStoreDiff<S>) => Promise<Record<string, unknown>>
): Promise<GsmStoreDiff<S> | null> {
  return withStorageLock(async () => {
    const diff = await change(await load());
    if (!diff || (!diff.changed && !diff.add.length && !diff.subtract.length)) return diff;
    const write: Record<string, unknown> = { [key]: diff.store, ...(extra ? await extra(diff) : {}) };
    if (!diff.add.length && !diff.subtract.length) {
      await browser.storage.local.set(write);
      return diff;
    }
    await withStatsUpdate(async () => {
      let stats = await loadStats();
      for (const entry of diff.subtract) stats = applyStatsSubtraction(stats, entry, dayStartHour);
      for (const entry of diff.add) stats = applyStatsAddition(stats, entry, dayStartHour);
      await browser.storage.local.set({ ...write, [STORAGE_KEYS.STATS]: stats });
    });
    return diff;
  });
}

function commit(
  dayStartHour: number,
  change: (store: GsmLocalStore) => GsmLocalDiff | null,
  extra?: (diff: GsmLocalDiff) => Promise<Record<string, unknown>>
): Promise<GsmLocalDiff | null> {
  return commitGsmStore(STORAGE_KEYS.GSM_LOCAL, loadGsmLocalStore, dayStartHour, change, extra);
}

export async function applyLocalDays(days: PlannedDay[], ctx: GsmLocalContext, dayStartHour: number): Promise<void> {
  if (!days.length) return;
  await commit(dayStartHour, store => reconcileLocalDays(store, days, ctx));
}

export async function applyLocalServerResult(
  sentIds: string[],
  rejectedIds: Set<string>,
  keptDeleted: Set<string> | null,
  dayStartHour: number
): Promise<void> {
  if (keptDeleted === null || !sentIds.length) return;
  await commit(dayStartHour, store => applyServerResult(store, sentIds, rejectedIds, keptDeleted));
}

export async function deleteGsmLocalSession(sessionId: string, dayStartHour: number): Promise<boolean> {
  const diff = await commit(
    dayStartHour,
    store => setGsmLocalState(store, sessionId, 'live', 'deleted'),
    async next => ({ [STORAGE_KEYS.DELETED_ENTRIES]: await buildStashedSnapshots(next.subtract[0]) })
  );
  return diff !== null;
}

export async function restoreGsmLocalSession(sessionId: string, dayStartHour: number): Promise<boolean> {
  const diff = await commit(dayStartHour, store => setGsmLocalState(store, sessionId, 'deleted', 'live'));
  if (diff) return true;
  return (await loadGsmLocalStore()).sessions[sessionId]?.state === 'live';
}

export async function loadGsmViewEntries(): Promise<PendingEntry[]> {
  return gsmViewEntries(await loadGsmLocalStore());
}

export async function locallyDeletedIds(): Promise<Set<string>> {
  const { sessions } = await loadGsmLocalStore();
  return new Set(Object.keys(sessions).filter(sid => sessions[sid].state === 'deleted'));
}
