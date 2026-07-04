import { STORAGE_KEYS } from '../../types';
import type { PendingEntry, ExtensionStats, JP343UserState } from '../../types';
import { containsKanji, isJapaneseContent } from '../language-detection';
import { isJapaneseGatedPlatform } from './tracking-messages';
import type { BackgroundMessageContext } from './message-context';

const CONTRIB_URL = 'https://jp343.com/wp-json/jp343/v1/difficulty/contribute';
const SEND_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_CHANNEL_MINUTES = 30;
const MAX_CHANNELS = 50;

interface ContribState {
  installId: string;
  lastSentAt: number;
}

interface ContribChannel {
  key: string;
  platform: string;
  minutesBucket: string;
}

function totalHoursBucket(hours: number): string {
  if (hours < 10) return '<10';
  if (hours < 60) return '10-60';
  if (hours < 250) return '60-250';
  if (hours < 600) return '250-600';
  return '600+';
}

function channelMinutesBucket(minutes: number): string {
  if (minutes < 120) return '30-120';
  if (minutes < 600) return '120-600';
  return '600+';
}

function hasJapaneseSignal(entry: PendingEntry): boolean {
  if (!isJapaneseGatedPlatform(entry.platform)) return true;
  const name = entry.channelName ?? '';
  const project = entry.project ?? '';
  return isJapaneseContent(name) || containsKanji(name)
    || isJapaneseContent(project) || containsKanji(project);
}

function collectChannels(entries: PendingEntry[]): ContribChannel[] {
  const totals = new Map<string, { platform: string; minutes: number; japanese: boolean }>();
  for (const entry of entries) {
    const key = (entry.channelId || entry.channelName || '').trim().toLowerCase();
    if (!key) continue;
    const existing = totals.get(key);
    if (existing) {
      existing.minutes += entry.duration_min;
      existing.japanese = existing.japanese || hasJapaneseSignal(entry);
    } else {
      totals.set(key, { platform: entry.platform, minutes: entry.duration_min, japanese: hasJapaneseSignal(entry) });
    }
  }
  const channels: ContribChannel[] = [];
  for (const [key, info] of totals) {
    if (info.minutes < MIN_CHANNEL_MINUTES) continue;
    if (!info.japanese) continue;
    channels.push({ key, platform: info.platform, minutesBucket: channelMinutesBucket(info.minutes) });
  }
  return channels.slice(0, MAX_CHANNELS);
}

export async function maybeContribute(context: BackgroundMessageContext): Promise<void> {
  try {
    const settings = await context.loadSettings();
    if (settings.contributeAnonymousStats !== true) return;
    if (settings.showDifficultyLevels === false) return;

    const stored = await browser.storage.local.get([
      STORAGE_KEYS.USER,
      STORAGE_KEYS.DIFFICULTY_CONTRIB,
      STORAGE_KEYS.PENDING,
      STORAGE_KEYS.STATS
    ]);

    const user = stored[STORAGE_KEYS.USER] as JP343UserState | undefined;
    if (user?.extApiToken) return;

    let state = stored[STORAGE_KEYS.DIFFICULTY_CONTRIB] as ContribState | undefined;
    if (!state) {
      state = { installId: crypto.randomUUID(), lastSentAt: 0 };
    }
    if (Date.now() - state.lastSentAt < SEND_INTERVAL_MS) return;

    const entries = (stored[STORAGE_KEYS.PENDING] as PendingEntry[] | undefined) ?? [];
    const stats = stored[STORAGE_KEYS.STATS] as ExtensionStats | undefined;
    const channels = collectChannels(entries);

    state.lastSentAt = Date.now();
    await browser.storage.local.set({ [STORAGE_KEYS.DIFFICULTY_CONTRIB]: state });
    if (channels.length === 0) return;

    const body = {
      installId: state.installId,
      totalHoursBucket: totalHoursBucket((stats?.totalMinutes ?? 0) / 60),
      channels
    };
    const response = await fetch(CONTRIB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    context.log('[JP343] Anonymous contribution sent:', channels.length, 'channels, status', response.status);
  } catch (error) {
    context.log('[JP343] Anonymous contribution failed:', error);
  }
}
