import { STORAGE_KEYS } from '../../types';
import type { ExtensionSettings, JP343UserState } from '../../types';
import { withStorageLock } from '../storage-lock';
import { getInstallId } from '../install-id';

// anonymous opt-in per-video harvest
const CONTRIB_ENDPOINT = 'https://jp343.com/wp-json/jp343/v1/difficulty/video-contribute';
const QUEUE_CAP = 200;
const FLUSH_MAX = 50;
const FLUSH_TIMEOUT_MS = 10000;

export interface DifficultyContribEntry {
  videoId: string;
  level: number;
  mixed: boolean;
  methodVersion: string;
  channelKey: string | null;
}

async function loadQueue(): Promise<DifficultyContribEntry[]> {
  const result = await browser.storage.local.get(STORAGE_KEYS.DIFFICULTY_CONTRIB_QUEUE);
  const queue = result[STORAGE_KEYS.DIFFICULTY_CONTRIB_QUEUE];
  return Array.isArray(queue) ? queue as DifficultyContribEntry[] : [];
}

export async function queueDifficultyContrib(entry: DifficultyContribEntry): Promise<void> {
  await withStorageLock(async () => {
    const queue = await loadQueue();
    const next = queue.filter(e => e.videoId !== entry.videoId);
    next.push(entry);
    const capped = next.length > QUEUE_CAP ? next.slice(next.length - QUEUE_CAP) : next;
    await browser.storage.local.set({ [STORAGE_KEYS.DIFFICULTY_CONTRIB_QUEUE]: capped });
  });
}

export async function flushDifficultyContrib(): Promise<void> {
  const stored = await browser.storage.local.get([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.USER]);
  const settings = stored[STORAGE_KEYS.SETTINGS] as ExtensionSettings | undefined;
  const user = stored[STORAGE_KEYS.USER] as JP343UserState | undefined;
  if (!settings?.difficultyContribEnabled) return;
  if (user?.isLoggedIn) return;

  const queue = await loadQueue();
  if (queue.length === 0) return;
  const batch = queue.slice(0, FLUSH_MAX);
  const installId = await getInstallId();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FLUSH_TIMEOUT_MS);
  try {
    const response = await fetch(CONTRIB_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        installId,
        platform: 'youtube',
        videos: batch.map(e => ({
          videoId: e.videoId,
          level: e.level,
          mixed: e.mixed,
          methodVersion: e.methodVersion,
          channelKey: e.channelKey ?? ''
        }))
      })
    });
    if (!response.ok) return;
    const result = await response.json().catch(() => null) as { success?: boolean; throttled?: boolean } | null;
    if (!result?.success || result.throttled) return;
    await withStorageLock(async () => {
      const current = await loadQueue();
      const flushed = new Set(batch.map(e => e.videoId));
      const remaining = current.filter(e => !flushed.has(e.videoId));
      await browser.storage.local.set({ [STORAGE_KEYS.DIFFICULTY_CONTRIB_QUEUE]: remaining });
    });
  } catch {
    // best-effort, retry on next flush
  } finally {
    clearTimeout(timeout);
  }
}
