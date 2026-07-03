import type { ExtensionMessage } from '../../types';
import { STORAGE_KEYS } from '../../types';
import type { BackgroundMessageContext } from './message-context';
import type { DifficultySeed } from '../difficulty-seeds';

const HOTSET_URL = 'https://jp343.com/wp-json/jp343/v1/difficulty/hotset';
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

interface HotsetCache {
  fetchedAt: number;
  lastAttempt: number;
  channels: Record<string, HotsetEntry>;
}

type DifficultyMessage = Extract<ExtensionMessage, { type: 'GET_DIFFICULTY' }>;

let refreshInFlight = false;

async function loadCache(): Promise<HotsetCache | null> {
  const result = await browser.storage.local.get(STORAGE_KEYS.DIFFICULTY_HOTSET);
  return (result[STORAGE_KEYS.DIFFICULTY_HOTSET] as HotsetCache | undefined) ?? null;
}

async function refreshHotset(previous: HotsetCache | null, log: (...args: unknown[]) => void): Promise<void> {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const response = await fetch(HOTSET_URL);
    if (!response.ok) {
      await browser.storage.local.set({
        [STORAGE_KEYS.DIFFICULTY_HOTSET]: {
          fetchedAt: previous?.fetchedAt ?? 0,
          lastAttempt: Date.now(),
          channels: previous?.channels ?? {}
        }
      });
      return;
    }
    const payload = await response.json() as { channels?: Record<string, HotsetEntry> };
    if (!payload.channels) return;
    await browser.storage.local.set({
      [STORAGE_KEYS.DIFFICULTY_HOTSET]: {
        fetchedAt: Date.now(),
        lastAttempt: Date.now(),
        channels: payload.channels
      }
    });
    log('[JP343] Difficulty hotset refreshed:', Object.keys(payload.channels).length, 'keys');
  } catch (error) {
    log('[JP343] Difficulty hotset fetch failed:', error);
  } finally {
    refreshInFlight = false;
  }
}

function maybeRefresh(cache: HotsetCache | null, log: (...args: unknown[]) => void): void {
  const now = Date.now();
  const stale = !cache || now - cache.fetchedAt > REFRESH_MS;
  const retryOk = !cache || now - cache.lastAttempt > RETRY_MS;
  if (stale && retryOk) {
    void refreshHotset(cache, log);
  }
}

function toSeed(entry: HotsetEntry): DifficultySeed {
  const mixed = entry.l === null || (entry.min !== null && entry.max !== null && entry.min !== entry.max);
  const base = entry.l ?? (entry.min !== null && entry.max !== null ? (entry.min + entry.max) / 2 : 3);
  const level = Math.min(5, Math.max(1, Math.round(base))) as 1 | 2 | 3 | 4 | 5;
  return { level, jlptHint: entry.hint || '', mixed };
}

export async function handleDifficultyMessage(
  message: DifficultyMessage,
  context: BackgroundMessageContext
): Promise<{ seed: DifficultySeed | null }> {
  const settings = await context.loadSettings();
  if (settings.showDifficultyLevels === false) return { seed: null };

  const cache = await loadCache();
  maybeRefresh(cache, context.log);
  if (!cache) return { seed: null };

  const keys = [message.channelId, message.channelName]
    .filter((k): k is string => typeof k === 'string' && k.length > 0)
    .map(k => k.trim().toLowerCase());

  for (const key of keys) {
    const entry = cache.channels[key];
    if (entry) return { seed: toSeed(entry) };
  }
  return { seed: null };
}
