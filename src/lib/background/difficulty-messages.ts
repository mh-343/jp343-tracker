import { STORAGE_KEYS } from '../../types';
import type { JP343UserState } from '../../types';
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

const VOTE_FETCH_TIMEOUT_MS = 10000;
const VOTE_STATE_ELIGIBLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const VOTE_STATE_RETRY_TTL_MS = 45 * 60 * 1000;
const VOTE_STATE_CAP = 300;

interface VoteStateEntry {
  eligible: boolean;
  vote: { level: number | null; mixed: boolean } | null;
  at: number;
}

export interface VoteStateResponse {
  eligible: boolean;
  vote: { level: number | null; mixed: boolean } | null;
}

export interface VoteSubmitResponse {
  success: boolean;
  code?: string;
  message?: string;
  votesForChannel?: number;
}

function channelVoteKey(channelId: string | null, channelName: string | null): string | null {
  const raw = channelId || channelName;
  return raw ? raw.trim().toLowerCase() : null;
}

async function loadUserState(): Promise<JP343UserState | null> {
  const result = await browser.storage.local.get(STORAGE_KEYS.USER);
  return (result[STORAGE_KEYS.USER] as JP343UserState | undefined) ?? null;
}

async function loadVoteStateCache(): Promise<Record<string, VoteStateEntry>> {
  const result = await browser.storage.local.get(STORAGE_KEYS.DIFFICULTY_VOTE_STATE);
  return (result[STORAGE_KEYS.DIFFICULTY_VOTE_STATE] as Record<string, VoteStateEntry> | undefined) ?? {};
}

async function saveVoteStateEntry(key: string, entry: VoteStateEntry): Promise<void> {
  await withStorageLock(async () => {
    const cache = await loadVoteStateCache();
    cache[key] = entry;
    const keys = Object.keys(cache);
    if (keys.length > VOTE_STATE_CAP) {
      const oldest = keys.sort((a, b) => cache[a].at - cache[b].at);
      for (const k of oldest.slice(0, keys.length - VOTE_STATE_CAP)) delete cache[k];
    }
    await browser.storage.local.set({ [STORAGE_KEYS.DIFFICULTY_VOTE_STATE]: cache });
  });
}

function toVote(raw: unknown): { level: number | null; mixed: boolean } | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as { level?: unknown; mixed?: unknown };
  const level = typeof v.level === 'number' ? v.level : null;
  const mixed = v.mixed === true || v.mixed === 1 || v.mixed === '1';
  if (level === null && !mixed) return null;
  return { level, mixed };
}

// Asks the server, 30 min gate lives there
export async function handleGetVoteState(
  message: { channelId: string | null; channelName: string | null; channelUrl: string | null },
  context: BackgroundMessageContext
): Promise<VoteStateResponse> {
  const none: VoteStateResponse = { eligible: false, vote: null };
  const settings = await context.loadSettings();
  if (settings.showDifficultyLevels === false || settings.difficultyLocalOnly) return none;
  const user = await loadUserState();
  if (!user?.extApiToken) return none;
  const key = channelVoteKey(message.channelId, message.channelName);
  if (!key) return none;

  const cache = await loadVoteStateCache();
  const cached = cache[key];
  if (cached) {
    const ttl = cached.eligible ? VOTE_STATE_ELIGIBLE_TTL_MS : VOTE_STATE_RETRY_TTL_MS;
    if (Date.now() - cached.at < ttl) return { eligible: cached.eligible, vote: cached.vote };
  }

  const ajaxUrl = user.ajaxUrl || 'https://jp343.com/wp-admin/admin-ajax.php';
  const params = new URLSearchParams();
  params.set('action', 'jp343_extension_get_vote_state');
  params.set('ext_api_token', user.extApiToken);
  params.set('platform', 'youtube');
  if (message.channelId) params.set('channel_id', message.channelId);
  if (message.channelName) params.set('channel_name', message.channelName);
  if (message.channelUrl) params.set('channel_url', message.channelUrl);

  const stale: VoteStateResponse = cached ? { eligible: cached.eligible, vote: cached.vote } : none;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VOTE_FETCH_TIMEOUT_MS);
  let result: { success?: boolean; data?: { eligible?: boolean; vote?: unknown } };
  try {
    const response = await fetch(ajaxUrl, { method: 'POST', signal: controller.signal, body: params });
    if (!response.ok) return stale;
    result = await response.json() as typeof result;
  } catch {
    return stale;
  } finally {
    clearTimeout(timeout);
  }
  if (!result.success || !result.data) return stale;
  const entry: VoteStateEntry = {
    eligible: result.data.eligible === true,
    vote: toVote(result.data.vote),
    at: Date.now()
  };
  await saveVoteStateEntry(key, entry);
  return { eligible: entry.eligible, vote: entry.vote };
}

export async function handleSubmitDifficultyVote(message: {
  channelId: string | null;
  channelName: string | null;
  channelUrl: string | null;
  videoId: string | null;
  level: number | null;
  mixed: boolean;
}): Promise<VoteSubmitResponse> {
  const user = await loadUserState();
  if (!user?.extApiToken) return { success: false, code: 'auth_required' };
  if (!message.mixed && (!message.level || message.level < 1 || message.level > 5)) {
    return { success: false, code: 'invalid_input' };
  }
  const ajaxUrl = user.ajaxUrl || 'https://jp343.com/wp-admin/admin-ajax.php';
  const params = new URLSearchParams();
  params.set('action', 'jp343_extension_vote_difficulty');
  params.set('ext_api_token', user.extApiToken);
  params.set('platform', 'youtube');
  if (message.channelId) params.set('channel_id', message.channelId);
  if (message.channelName) params.set('channel_name', message.channelName);
  if (message.channelUrl) params.set('channel_url', message.channelUrl);
  if (message.videoId) params.set('video_id', message.videoId);
  if (message.mixed) params.set('mixed', '1');
  else params.set('level', String(message.level));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VOTE_FETCH_TIMEOUT_MS);
  let result: { success?: boolean; data?: { code?: string; message?: string; votesForChannel?: number } };
  try {
    const response = await fetch(ajaxUrl, { method: 'POST', signal: controller.signal, body: params });
    if (!response.ok) return { success: false, code: 'server_error' };
    result = await response.json() as typeof result;
  } catch {
    return { success: false, code: 'network' };
  } finally {
    clearTimeout(timeout);
  }
  if (!result.success) {
    return { success: false, code: result.data?.code || 'server_error', message: result.data?.message };
  }
  const key = channelVoteKey(message.channelId, message.channelName);
  if (key) {
    await saveVoteStateEntry(key, {
      eligible: true,
      vote: { level: message.mixed ? null : message.level, mixed: message.mixed },
      at: Date.now()
    });
  }
  return { success: true, votesForChannel: result.data?.votesForChannel };
}
