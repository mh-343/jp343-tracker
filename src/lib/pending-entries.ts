import { STORAGE_KEYS } from '../types';
import type { PendingEntry } from '../types';

export async function loadPendingEntries(): Promise<PendingEntry[]> {
  try {
    const result = await browser.storage.local.get(STORAGE_KEYS.PENDING);
    return result[STORAGE_KEYS.PENDING] || [];
  } catch {
    return [];
  }
}
