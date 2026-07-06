// persistent local band cache read (Paket J)
import { STORAGE_KEYS } from '../../types';
import type { DifficultySeed } from '../../lib/difficulty-seeds';

export interface LocalBand {
  seed: DifficultySeed;
  source: string;
}

interface StoredCache {
  methodVersion: string;
  entries: Record<string, { seed: DifficultySeed | null; source: string | null }>;
}

export async function readLocalBandCache(methodVersion: string): Promise<Record<string, LocalBand | null> | null> {
  try {
    const result = await browser.storage.local.get(STORAGE_KEYS.DIFFICULTY_LOCAL);
    const cache = result[STORAGE_KEYS.DIFFICULTY_LOCAL] as StoredCache | undefined;
    if (!cache || cache.methodVersion !== methodVersion) return null;
    const out: Record<string, LocalBand | null> = {};
    for (const [id, entry] of Object.entries(cache.entries)) {
      out[id] = entry.seed ? { seed: entry.seed, source: entry.source ?? 'local estimate' } : null;
    }
    return out;
  } catch {
    return null;
  }
}
