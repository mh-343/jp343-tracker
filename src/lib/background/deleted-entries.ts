import type { DeletedEntrySnapshot, JP343UserState, PendingEntry } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { withStorageLock } from '../storage-lock';

const MAX_SNAPSHOTS = 20;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function prune(snapshots: DeletedEntrySnapshot[]): DeletedEntrySnapshot[] {
  const cutoff = Date.now() - MAX_AGE_MS;
  return snapshots.filter(s => s.deletedAt >= cutoff).slice(0, MAX_SNAPSHOTS);
}

async function loadRaw(): Promise<DeletedEntrySnapshot[]> {
  const res = await browser.storage.local.get(STORAGE_KEYS.DELETED_ENTRIES);
  return (res[STORAGE_KEYS.DELETED_ENTRIES] as DeletedEntrySnapshot[] | undefined) ?? [];
}

async function saveRaw(snapshots: DeletedEntrySnapshot[]): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.DELETED_ENTRIES]: snapshots });
}

export async function loadDeletedSnapshots(): Promise<DeletedEntrySnapshot[]> {
  const raw = await loadRaw();
  const pruned = prune(raw);
  if (pruned.length !== raw.length) {
    await withStorageLock(async () => {
      const current = await loadRaw();
      const cleaned = prune(current);
      if (cleaned.length !== current.length) await saveRaw(cleaned);
    });
  }
  return pruned;
}

export async function currentUserId(): Promise<number | null> {
  const res = await browser.storage.local.get(STORAGE_KEYS.USER);
  return (res[STORAGE_KEYS.USER] as JP343UserState | undefined)?.userId ?? null;
}

// Server rows bind to the deleting user
export function snapshotVisibleFor(snapshot: DeletedEntrySnapshot, userId: number | null): boolean {
  return snapshot.userId == null || snapshot.userId === userId;
}

// Caller must hold the storage lock
export async function stashDeletedEntry(entry: PendingEntry): Promise<void> {
  const userId = entry.serverEntryId != null ? await currentUserId() : null;
  const snapshots = await loadRaw();
  await saveRaw(prune([
    { deletedAt: Date.now(), entry, userId },
    ...snapshots.filter(s => s.entry.id !== entry.id)
  ]));
}

export async function takeDeletedSnapshot(entryId: string): Promise<DeletedEntrySnapshot | null> {
  return withStorageLock(async () => {
    const snapshots = await loadRaw();
    const match = snapshots.find(s => s.entry.id === entryId) ?? null;
    if (match) {
      await saveRaw(snapshots.filter(s => s.entry.id !== entryId));
    }
    return match;
  });
}

export async function putDeletedSnapshot(snapshot: DeletedEntrySnapshot): Promise<void> {
  await withStorageLock(async () => {
    const snapshots = await loadRaw();
    const merged = [
      snapshot,
      ...snapshots.filter(s => s.entry.id !== snapshot.entry.id)
    ].sort((a, b) => b.deletedAt - a.deletedAt);
    await saveRaw(prune(merged));
  });
}
