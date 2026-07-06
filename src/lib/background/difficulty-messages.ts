import { STORAGE_KEYS } from '../../types';
import type { BackgroundMessageContext } from './message-context';
import { maybeContribute } from './difficulty-contrib';
import type { DifficultySeed } from '../difficulty-seeds';

const HOTSET_URL = 'https://jp343.com/wp-json/jp343/v1/difficulty/hotset';
const VIDEOSET_URL = 'https://jp343.com/wp-json/jp343/v1/difficulty/videoset';
const REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;

interface HotsetEntry {
  l: number | null;
  min: number | null;
  max: number | null;
  hint: string;
  src: string;
  conf: number;
}

interface VideosetEntry {
  min: number;
  max: number;
  hint: string;
}

interface StaticSetCache<T> {
  fetchedAt: number;
  lastAttempt: number;
  entries: Record<string, T>;
}

// Full-set fetch only, no per-item lookup
function makeStaticSet<T>(url: string, storageKey: string, payloadField: string) {
  let inFlight = false;

  async function load(): Promise<StaticSetCache<T> | null> {
    const result = await browser.storage.local.get(storageKey);
    const cache = result[storageKey] as StaticSetCache<T> | undefined;
    if (!cache?.entries) return null;
    return cache;
  }

  async function refresh(previous: StaticSetCache<T> | null, log: (...args: unknown[]) => void): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        await browser.storage.local.set({
          [storageKey]: {
            fetchedAt: previous?.fetchedAt ?? 0,
            lastAttempt: Date.now(),
            entries: previous?.entries ?? {}
          }
        });
        return;
      }
      const payload = await response.json() as Record<string, unknown>;
      const entries = payload[payloadField] as Record<string, T> | undefined;
      if (!entries) return;
      await browser.storage.local.set({
        [storageKey]: { fetchedAt: Date.now(), lastAttempt: Date.now(), entries }
      });
      log('[JP343] Difficulty set refreshed:', payloadField, Object.keys(entries).length, 'keys');
    } catch (error) {
      log('[JP343] Difficulty set fetch failed:', payloadField, error);
    } finally {
      inFlight = false;
    }
  }

  function maybeRefresh(cache: StaticSetCache<T> | null, log: (...args: unknown[]) => void): void {
    const now = Date.now();
    const stale = !cache || now - cache.fetchedAt > REFRESH_MS;
    const retryOk = !cache || now - cache.lastAttempt > RETRY_MS;
    if (stale && retryOk) void refresh(cache, log);
  }

  return { load, maybeRefresh };
}

const hotset = makeStaticSet<HotsetEntry>(HOTSET_URL, STORAGE_KEYS.DIFFICULTY_HOTSET, 'channels');
const videoset = makeStaticSet<VideosetEntry>(VIDEOSET_URL, STORAGE_KEYS.DIFFICULTY_VIDEOSET, 'videos');

function clampLevel(value: number): 1 | 2 | 3 | 4 | 5 {
  return Math.min(5, Math.max(1, Math.round(value))) as 1 | 2 | 3 | 4 | 5;
}

function channelSeed(entry: HotsetEntry): DifficultySeed {
  const mixed = entry.l === null || (entry.min !== null && entry.max !== null && entry.min !== entry.max);
  const base = entry.l ?? (entry.min !== null && entry.max !== null ? (entry.min + entry.max) / 2 : 3);
  return { level: clampLevel(base), jlptHint: entry.hint || '', mixed };
}

function videoSeed(entry: VideosetEntry): DifficultySeed {
  return { level: clampLevel((entry.min + entry.max) / 2), jlptHint: entry.hint || '' };
}

function toSeeds<T>(entries: Record<string, T>, convert: (entry: T) => DifficultySeed): Record<string, DifficultySeed> {
  const seeds: Record<string, DifficultySeed> = {};
  for (const [key, entry] of Object.entries(entries)) {
    seeds[key] = convert(entry);
  }
  return seeds;
}

export interface DifficultyMapResponse {
  channels: Record<string, DifficultySeed> | null;
  videos: Record<string, DifficultySeed> | null;
}

export async function handleDifficultyMapMessage(
  context: BackgroundMessageContext
): Promise<DifficultyMapResponse> {
  void maybeContribute(context);
  const settings = await context.loadSettings();
  if (settings.showDifficultyLevels === false) return { channels: null, videos: null };

  const [hotCache, videoCache] = await Promise.all([hotset.load(), videoset.load()]);
  hotset.maybeRefresh(hotCache, context.log);
  videoset.maybeRefresh(videoCache, context.log);

  return {
    channels: hotCache ? toSeeds(hotCache.entries, channelSeed) : null,
    videos: videoCache ? toSeeds(videoCache.entries, videoSeed) : null
  };
}
