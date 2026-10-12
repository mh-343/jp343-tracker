import type { PendingEntry, ReaderBaseline, ReaderState, ReaderVolumeSnapshot } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { resetEntrySync } from '../sync-policy';
import { readSyncPending } from './sync-queue';

const PREFIX = 'ext_ttu_';
const CONTENT_ID = /^[0-9a-f]{16,64}$/;
const LEGACY_ID = /^[0-9a-f]{8}$/;

export interface AdoptedTtuIds {
  volumes: Record<string, ReaderVolumeSnapshot>;
  // old project id -> new project id
  moves: Map<string, string>;
}

function legacyIdsOf(vol: ReaderVolumeSnapshot): string[] {
  return Array.isArray(vol.legacyIds) ? vol.legacyIds.filter(id => typeof id === 'string' && LEGACY_ID.test(id)) : [];
}

function mergeVolumes(a: ReaderVolumeSnapshot, b: ReaderVolumeSnapshot): ReaderVolumeSnapshot {
  return {
    ...a,
    effectiveMin: a.effectiveMin + b.effectiveMin,
    chars: a.chars + b.chars,
    completed: a.completed || b.completed,
    legacyIds: [...new Set([...legacyIdsOf(a), ...legacyIdsOf(b)])]
  };
}

// sum keeps deltas exact; a missing part means rebase
function movedBaseline(state: ReaderState, to: string, froms: Set<string>): ReaderBaseline | undefined {
  const known = [...froms].map(from => state.baselines[from]).filter((b): b is ReaderBaseline => !!b);
  const current = state.baselines[to];
  if (!current && known.length !== froms.size) return undefined;
  const parts = current ? [current, ...known] : known;
  if (!parts.length) return undefined;
  return {
    lastEffectiveMin: parts.reduce((sum, b) => sum + b.lastEffectiveMin, 0),
    lastChars: parts.reduce((sum, b) => sum + b.lastChars, 0),
    lastObservedAt: Math.max(...parts.map(b => b.lastObservedAt))
  };
}

function moveVolumeState(state: ReaderState, to: string, froms: Set<string>, moves: Map<string, string>): void {
  const baseline = movedBaseline(state, to, froms);
  if (baseline) state.baselines[to] = baseline;
  else delete state.baselines[to];
  for (const from of froms) {
    delete state.baselines[from];
    if (state.completedVolumes[from]) state.completedVolumes[to] = true;
    delete state.completedVolumes[from];
    moves.set(PREFIX + from, PREFIX + to);
  }
  const rekey = (pids: string[]) => [...new Set(pids.map(pid => moves.get(pid) ?? pid))];
  state.pendingCompletionPushes = rekey(state.pendingCompletionPushes);
  if (state.completionBackfill) state.completionBackfill.pending = rekey(state.completionBackfill.pending);
}

// books with a text hash leave their old title id
export function adoptTtuIds(state: ReaderState, volumes: Record<string, ReaderVolumeSnapshot>): AdoptedTtuIds {
  const contentIds = { ...(state.contentIds ?? {}) };
  const takeovers = { ...(state.takeovers ?? {}) };
  const seen = new Set(Object.values(contentIds));
  const incoming = new Map<string, Set<string>>();
  const out: Record<string, ReaderVolumeSnapshot> = {};

  for (const [key, vol] of Object.entries(volumes)) {
    let id = key;
    let legacy = legacyIdsOf(vol);
    if (LEGACY_ID.test(key) && contentIds[key]) {
      id = contentIds[key];
      legacy = [key];
    }
    if (!CONTENT_ID.test(id) || !legacy.length) {
      out[key] = out[key] ? mergeVolumes(out[key], vol) : vol;
      continue;
    }
    for (const old of legacy) {
      const previous = contentIds[old];
      if (previous === id) continue;
      contentIds[old] = id;
      const from = previous ?? old;
      if (previous) delete takeovers[previous];
      incoming.set(id, (incoming.get(id) ?? new Set<string>()).add(from));
    }
    if (!seen.has(id) && !takeovers[id]) takeovers[id] = legacy[0];
    const tagged = { ...vol, legacyIds: legacy };
    out[id] = out[id] ? mergeVolumes(out[id], tagged) : tagged;
  }

  const moves = new Map<string, string>();
  for (const [to, froms] of incoming) moveVolumeState(state, to, froms, moves);
  state.contentIds = contentIds;
  state.takeovers = takeovers;
  return { volumes: out, moves };
}

// caller holds the storage lock
export async function rekeyPendingTtu(moves: Map<string, string>): Promise<void> {
  if (!moves.size) return;
  const pending: PendingEntry[] = await readSyncPending();
  let changed = false;
  for (const entry of pending) {
    const to = moves.get(entry.project_id);
    if (!to || entry.synced || entry.platform !== 'ttu') continue;
    entry.project_id = to;
    resetEntrySync(entry);
    changed = true;
  }
  if (changed) await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: pending });
}
