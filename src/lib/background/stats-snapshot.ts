let revision = 0;
let pendingUpdates = 0;

export function statsSnapshotRevision(): number | null {
  return pendingUpdates === 0 ? revision : null;
}

export async function withStatsUpdate<T>(update: () => Promise<T>): Promise<T> {
  pendingUpdates++;
  revision++;
  try {
    return await update();
  } finally {
    revision++;
    pendingUpdates--;
  }
}
