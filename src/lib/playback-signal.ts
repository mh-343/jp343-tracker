import type { ActivityType, Platform } from '../types';
import { PLATFORM_ACTIVITY_TYPE } from '../types';
import type { MpchcState } from './mpchc';

// Page contract with the theme's podcast guard (js/features/podcast-ext-guard.js).
// Additive fields only; bump v on a breaking change.
export const PLAYBACK_SIGNAL_ATTR = 'data-jp343-ext-playback';

export type PlaybackSignal =
  | { v: 1; playing: false }
  | { v: 1; playing: boolean; activity: ActivityType; manual: boolean; key: string; at: number; local?: true };

// Built from the stored session; no title, url or channel reaches the page.
export function playbackSignalFrom(stored: unknown): PlaybackSignal {
  if (!stored || typeof stored !== 'object') return { v: 1, playing: false };
  const s = stored as Record<string, unknown>;
  if (
    typeof s.id !== 'string' ||
    typeof s.platform !== 'string' ||
    !(s.platform in PLATFORM_ACTIVITY_TYPE) ||
    typeof s.lastUpdate !== 'number'
  ) {
    return { v: 1, playing: false };
  }
  const platform = s.platform as Platform;
  const activity = typeof s.activityType === 'string'
    ? s.activityType as ActivityType
    : PLATFORM_ACTIVITY_TYPE[platform];
  const rootId = Array.isArray(s.previousIds) && typeof s.previousIds[0] === 'string'
    ? s.previousIds[0]
    : s.id;
  return {
    v: 1,
    playing: s.isActive === true && s.isPaused !== true,
    activity,
    manual: platform === 'generic' && !s.customSiteHost,
    key: rootId,
    at: s.lastUpdate
  };
}

// MPC-HC, refreshed every poll
export function playerSignalFrom(stored: unknown): PlaybackSignal {
  if (!stored || typeof stored !== 'object') return { v: 1, playing: false };
  const s = stored as Partial<MpchcState>;
  const session = s.session;
  if (
    s.enabled !== true ||
    s.status !== 'playing' ||
    !session ||
    typeof session.id !== 'string' ||
    typeof session.lastPollAt !== 'number'
  ) {
    return { v: 1, playing: false };
  }
  return {
    v: 1,
    playing: session.lastPlaying === true,
    activity: 'watching',
    manual: false,
    key: session.id,
    at: session.lastPollAt,
    local: true
  };
}

function overlaps(signal: PlaybackSignal): boolean {
  return 'activity' in signal && signal.playing && !signal.manual
    && (signal.activity === 'watching' || signal.activity === 'listening');
}

// one signal; browser session first
export function combinedPlaybackSignal(browserSignal: PlaybackSignal, playerSignal: PlaybackSignal): PlaybackSignal {
  return overlaps(browserSignal) || !overlaps(playerSignal) ? browserSignal : playerSignal;
}
