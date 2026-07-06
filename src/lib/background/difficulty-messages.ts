import { STORAGE_KEYS } from '../../types';
import type { BackgroundMessageContext } from './message-context';
import { clampLevel } from '../difficulty-seeds';
import type { DifficultySeed, ChannelBounds } from '../difficulty-seeds';
import { withStorageLock } from '../storage-lock';

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

function channelSeed(entry: HotsetEntry): DifficultySeed {
  const mixed = entry.l === null || (entry.min !== null && entry.max !== null && entry.min !== entry.max);
  const base = entry.l ?? (entry.min !== null && entry.max !== null ? (entry.min + entry.max) / 2 : 3);
  return { level: clampLevel(base), jlptHint: entry.hint || '', mixed };
}

function videoSeed(entry: VideosetEntry): DifficultySeed {
  return { level: clampLevel((entry.min + entry.max) / 2), jlptHint: entry.hint || '' };
}

function channelBoundsOf(entry: HotsetEntry): ChannelBounds | null {
  if (entry.min === null || entry.max === null) return null;
  return { min: entry.min, max: entry.max, native: entry.min === 5 && entry.max === 5 };
}

function toChannelBounds(entries: Record<string, HotsetEntry>): Record<string, ChannelBounds> {
  const out: Record<string, ChannelBounds> = {};
  for (const [key, entry] of Object.entries(entries)) {
    const bounds = channelBoundsOf(entry);
    if (bounds) out[key] = bounds;
  }
  return out;
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
  channelBounds: Record<string, ChannelBounds> | null;
}

const EMPTY_RESPONSE: DifficultyMapResponse = { channels: null, videos: null, channelBounds: null };

export async function handleDifficultyMapMessage(
  context: BackgroundMessageContext
): Promise<DifficultyMapResponse> {
  const settings = await context.loadSettings();
  if (settings.showDifficultyLevels === false) return EMPTY_RESPONSE;
  if (settings.difficultyLocalOnly) return EMPTY_RESPONSE;

  const [hotCache, videoCache] = await Promise.all([hotset.load(), videoset.load()]);
  hotset.maybeRefresh(hotCache, context.log);
  videoset.maybeRefresh(videoCache, context.log);

  return {
    channels: hotCache ? toSeeds(hotCache.entries, channelSeed) : null,
    videos: videoCache ? toSeeds(videoCache.entries, videoSeed) : null,
    channelBounds: hotCache ? toChannelBounds(hotCache.entries) : null
  };
}

interface LocalBandEntry {
  seed: DifficultySeed | null;
  source: string | null;
  at: number;
}

interface LocalBandCache {
  methodVersion: string;
  entries: Record<string, LocalBandEntry>;
}

const LOCAL_CACHE_CAP = 2000;

export async function handleSaveLocalDifficultyBand(message: {
  videoId: string;
  seed: DifficultySeed | null;
  source: string | null;
  methodVersion: string;
}): Promise<{ success: boolean }> {
  await withStorageLock(async () => {
    const result = await browser.storage.local.get(STORAGE_KEYS.DIFFICULTY_LOCAL);
    const stored = result[STORAGE_KEYS.DIFFICULTY_LOCAL] as LocalBandCache | undefined;
    const cache: LocalBandCache = stored && stored.methodVersion === message.methodVersion
      ? stored
      : { methodVersion: message.methodVersion, entries: {} };
    cache.entries[message.videoId] = { seed: message.seed, source: message.source, at: Date.now() };
    const keys = Object.keys(cache.entries);
    if (keys.length > LOCAL_CACHE_CAP) {
      const oldest = keys.sort((a, b) => cache.entries[a].at - cache.entries[b].at);
      for (const k of oldest.slice(0, keys.length - LOCAL_CACHE_CAP)) delete cache.entries[k];
    }
    await browser.storage.local.set({ [STORAGE_KEYS.DIFFICULTY_LOCAL]: cache });
  });
  return { success: true };
}
