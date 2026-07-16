import { STORAGE_KEYS } from '../../types';
import type { JP343UserState } from '../../types';
import type { BackgroundMessageContext } from './message-context';
import { clampLevel } from '../difficulty-seeds';
import type { DifficultySeed, ChannelBounds } from '../difficulty-seeds';
import { withStorageLock } from '../storage-lock';
import { queueDifficultyContrib } from './difficulty-contrib';

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
  channelKey: string | null;
}, context: BackgroundMessageContext): Promise<{ success: boolean }> {
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
  const settings = await context.loadSettings();
  const user = await loadUserState();
  if (settings.difficultyContribEnabled && !user?.isLoggedIn && message.seed) {
    await queueDifficultyContrib({
      videoId: message.videoId,
      level: message.seed.level,
      mixed: message.seed.mixed ?? false,
      methodVersion: message.methodVersion,
      channelKey: message.channelKey
    });
  }
  return { success: true };
}

const VOTE_FETCH_TIMEOUT_MS = 10000;
const VOTE_STATE_ELIGIBLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const VOTE_STATE_RETRY_TTL_MS = 45 * 60 * 1000;
const VOTE_STATE_CAP = 300;
const VOTE_STATE_VIDEO_CAP = 50;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const VOTE_CHOICES = ['nothing', 'little', 'most', 'all'];

interface StoredVote {
  level: number | null;
  mixed: boolean;
  choice: string | null;
  shownLevel: number | null;
}

interface VideoVoteEntry {
  vote: StoredVote | null;
  at: number;
}

interface VoteStateEntry {
  eligible: boolean;
  at: number;
  votes: Record<string, VideoVoteEntry>;
}

export interface VoteStateResponse {
  eligible: boolean;
  vote: StoredVote | null;
}

export interface VoteSubmitResponse {
  success: boolean;
  code?: string;
  message?: string;
  votesForChannel?: number;
  queued?: boolean;
}

function channelVoteKey(channelId: string | null, channelName: string | null): string | null {
  const raw = channelId || channelName;
  return raw ? raw.trim().toLowerCase() : null;
}

async function loadUserState(): Promise<JP343UserState | null> {
  const result = await browser.storage.local.get(STORAGE_KEYS.USER);
  return (result[STORAGE_KEYS.USER] as JP343UserState | undefined) ?? null;
}

let channelScopedCacheRemoved = false;

async function loadVoteStateCache(): Promise<Record<string, VoteStateEntry>> {
  if (!channelScopedCacheRemoved) {
    channelScopedCacheRemoved = true;
    void browser.storage.local.remove(STORAGE_KEYS.DIFFICULTY_VOTE_STATE);
  }
  const result = await browser.storage.local.get(STORAGE_KEYS.DIFFICULTY_VOTE_STATE_V2);
  return (result[STORAGE_KEYS.DIFFICULTY_VOTE_STATE_V2] as Record<string, VoteStateEntry> | undefined) ?? {};
}

async function saveVoteState(key: string, eligible: boolean, videoId: string | null, vote: StoredVote | null): Promise<void> {
  await withStorageLock(async () => {
    const cache = await loadVoteStateCache();
    const entry: VoteStateEntry = cache[key] ?? { eligible, at: 0, votes: {} };
    entry.eligible = eligible;
    entry.at = Date.now();
    if (videoId) {
      entry.votes[videoId] = { vote, at: Date.now() };
      const videoKeys = Object.keys(entry.votes);
      if (videoKeys.length > VOTE_STATE_VIDEO_CAP) {
        const oldest = videoKeys.sort((a, b) => entry.votes[a].at - entry.votes[b].at);
        for (const k of oldest.slice(0, videoKeys.length - VOTE_STATE_VIDEO_CAP)) delete entry.votes[k];
      }
    }
    cache[key] = entry;
    const keys = Object.keys(cache);
    if (keys.length > VOTE_STATE_CAP) {
      const oldest = keys.sort((a, b) => cache[a].at - cache[b].at);
      for (const k of oldest.slice(0, keys.length - VOTE_STATE_CAP)) delete cache[k];
    }
    await browser.storage.local.set({ [STORAGE_KEYS.DIFFICULTY_VOTE_STATE_V2]: cache });
  });
}

export async function clearVoteStateCache(): Promise<void> {
  await browser.storage.local.remove([STORAGE_KEYS.DIFFICULTY_VOTE_STATE, STORAGE_KEYS.DIFFICULTY_VOTE_STATE_V2]);
}

function toVote(raw: unknown): StoredVote | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as { level?: unknown; mixed?: unknown; choice?: unknown; shownLevel?: unknown };
  const level = typeof v.level === 'number' ? v.level : null;
  const mixed = v.mixed === true || v.mixed === 1 || v.mixed === '1';
  const choice = typeof v.choice === 'string' && v.choice ? v.choice : null;
  const shownLevel = typeof v.shownLevel === 'number' ? v.shownLevel : null;
  if (level === null && !mixed && !choice) return null;
  return { level, mixed, choice, shownLevel };
}

// Asks the server, 30 min gate lives there
export async function handleGetVoteState(
  message: { channelId: string | null; channelName: string | null; channelUrl: string | null; videoId: string | null },
  context: BackgroundMessageContext
): Promise<VoteStateResponse> {
  const none: VoteStateResponse = { eligible: false, vote: null };
  const settings = await context.loadSettings();
  if (settings.showDifficultyLevels === false || settings.difficultyLocalOnly) return none;
  const user = await loadUserState();
  if (!user?.extApiToken) return none;
  const key = channelVoteKey(message.channelId, message.channelName);
  if (!key) return none;
  const videoId = typeof message.videoId === 'string' && VIDEO_ID_PATTERN.test(message.videoId)
    ? message.videoId
    : null;

  const cache = await loadVoteStateCache();
  const cached = cache[key];
  const now = Date.now();
  const cachedVideoVote = cached && videoId ? cached.votes?.[videoId] : undefined;
  if (cached) {
    const ttl = cached.eligible ? VOTE_STATE_ELIGIBLE_TTL_MS : VOTE_STATE_RETRY_TTL_MS;
    if (now - cached.at < ttl) {
      if (!cached.eligible) return { eligible: false, vote: null };
      if (cachedVideoVote && now - cachedVideoVote.at < VOTE_STATE_ELIGIBLE_TTL_MS) {
        return { eligible: true, vote: cachedVideoVote.vote };
      }
    }
  }

  const ajaxUrl = user.ajaxUrl || 'https://jp343.com/wp-admin/admin-ajax.php';
  const params = new URLSearchParams();
  params.set('action', 'jp343_extension_get_vote_state');
  params.set('ext_api_token', user.extApiToken);
  params.set('platform', 'youtube');
  if (message.channelId) params.set('channel_id', message.channelId);
  if (message.channelName) params.set('channel_name', message.channelName);
  if (message.channelUrl) params.set('channel_url', message.channelUrl);
  if (videoId) params.set('video_id', videoId);

  const stale: VoteStateResponse = cached
    ? { eligible: cached.eligible, vote: cachedVideoVote?.vote ?? null }
    : none;
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
  const eligible = result.data.eligible === true;
  const vote = videoId ? toVote(result.data.vote) : null;
  await saveVoteState(key, eligible, videoId, vote);
  return { eligible, vote };
}

const WATCH_MORE_CODE = 'E108';
const MAX_VOTE_RETRY_ATTEMPTS = 5;

interface VotePayload {
  channelId: string | null;
  channelName: string | null;
  channelUrl: string | null;
  videoId: string | null;
  choice: string;
  shownLevel: number;
}

interface QueuedVote extends VotePayload {
  channelId: string;
  attempts: number;
  queuedAt: string;
}

async function loadQueuedVotes(): Promise<QueuedVote[]> {
  const result = await browser.storage.local.get(STORAGE_KEYS.PENDING_VOTES);
  return (result[STORAGE_KEYS.PENDING_VOTES] as QueuedVote[] | undefined) ?? [];
}

async function queueVoteForRetry(vote: VotePayload): Promise<void> {
  const channelId = vote.channelId;
  if (!channelId) return;
  await withStorageLock(async () => {
    const votes = await loadQueuedVotes();
    const kept = votes.filter(v => !(v.channelId === channelId && v.videoId === vote.videoId));
    kept.push({ ...vote, channelId, attempts: 0, queuedAt: new Date().toISOString() });
    await browser.storage.local.set({ [STORAGE_KEYS.PENDING_VOTES]: kept });
  });
}

type VotePostResult =
  | { ok: true; votesForChannel?: number }
  | { ok: false; code: string; message?: string };

async function postVoteToServer(user: JP343UserState, vote: VotePayload): Promise<VotePostResult> {
  if (!user.extApiToken) return { ok: false, code: 'auth_required' };
  const ajaxUrl = user.ajaxUrl || 'https://jp343.com/wp-admin/admin-ajax.php';
  const params = new URLSearchParams();
  params.set('action', 'jp343_extension_vote_difficulty');
  params.set('ext_api_token', user.extApiToken);
  params.set('platform', 'youtube');
  if (vote.channelId) params.set('channel_id', vote.channelId);
  if (vote.channelName) params.set('channel_name', vote.channelName);
  if (vote.channelUrl) params.set('channel_url', vote.channelUrl);
  if (vote.videoId) params.set('video_id', vote.videoId);
  params.set('choice', vote.choice);
  params.set('shown_level', String(vote.shownLevel));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VOTE_FETCH_TIMEOUT_MS);
  let result: { success?: boolean; data?: { code?: string; message?: string; votesForChannel?: number } };
  try {
    const response = await fetch(ajaxUrl, { method: 'POST', signal: controller.signal, body: params });
    if (!response.ok) return { ok: false, code: 'server_error' };
    result = await response.json() as typeof result;
  } catch {
    return { ok: false, code: 'network' };
  } finally {
    clearTimeout(timeout);
  }
  if (!result.success) {
    return { ok: false, code: result.data?.code || 'server_error', message: result.data?.message };
  }
  return { ok: true, votesForChannel: result.data?.votesForChannel };
}

async function cacheOwnVote(vote: VotePayload): Promise<void> {
  const key = channelVoteKey(vote.channelId, vote.channelName);
  if (!key) return;
  await saveVoteState(key, true, vote.videoId, {
    level: null,
    mixed: false,
    choice: vote.choice,
    shownLevel: vote.shownLevel
  });
}

export async function handleSubmitDifficultyVote(message: VotePayload): Promise<VoteSubmitResponse> {
  const user = await loadUserState();
  if (!user?.extApiToken) return { success: false, code: 'auth_required' };
  if (!VOTE_CHOICES.includes(message.choice)) {
    return { success: false, code: 'invalid_input' };
  }
  const result = await postVoteToServer(user, message);
  if (result.ok) {
    await cacheOwnVote(message);
    return { success: true, votesForChannel: result.votesForChannel };
  }
  // channel has no synced session yet: keep the vote, resubmit after sync
  if (result.code === WATCH_MORE_CODE && message.channelId) {
    await queueVoteForRetry(message);
    return { success: true, queued: true };
  }
  return { success: false, code: result.code, message: result.message };
}

export async function retryQueuedVotes(channelIds?: Array<string | null | undefined>): Promise<void> {
  const queued = await loadQueuedVotes();
  if (queued.length === 0) return;
  const ids = channelIds ? new Set(channelIds.filter((id): id is string => !!id)) : null;
  const targets = ids ? queued.filter(v => ids.has(v.channelId)) : queued;
  if (targets.length === 0) return;
  const user = await loadUserState();
  if (!user?.extApiToken) return;
  const keyOf = (v: QueuedVote): string => v.channelId + '|' + (v.videoId ?? '') + '|' + v.queuedAt;
  const done = new Set<string>();
  const bump = new Set<string>();
  for (const vote of targets) {
    const result = await postVoteToServer(user, vote);
    if (result.ok) {
      await cacheOwnVote(vote);
      done.add(keyOf(vote));
    } else if (vote.attempts + 1 >= MAX_VOTE_RETRY_ATTEMPTS) {
      done.add(keyOf(vote));
    } else {
      bump.add(keyOf(vote));
    }
  }
  await withStorageLock(async () => {
    const current = await loadQueuedVotes();
    const updated = current
      .filter(v => !done.has(keyOf(v)))
      .map(v => (bump.has(keyOf(v)) ? { ...v, attempts: v.attempts + 1 } : v));
    await browser.storage.local.set({ [STORAGE_KEYS.PENDING_VOTES]: updated });
  });
}
