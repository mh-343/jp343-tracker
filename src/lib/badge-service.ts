import { tracker } from './time-tracker';
import type { ExtensionSettings } from '../types';
import { getMpchcState } from './background/mpchc-poller';

const badgeApi = browser.action ?? browser.browserAction;

type TrackingStatus = 'recording' | 'paused' | 'ad' | 'idle';

let loadSettingsFn: (() => Promise<ExtensionSettings>) | null = null;
let badgeUpdateTimer: ReturnType<typeof setTimeout> | null = null;

export function initBadgeService(loadSettings: () => Promise<ExtensionSettings>): void {
  loadSettingsFn = loadSettings;
}

async function getCurrentStatus(): Promise<{ status: TrackingStatus; source: 'browser' | 'player' }> {
  if (tracker.isAdPlaying()) return { status: 'ad', source: 'browser' };
  const session = tracker.getCurrentSession();
  if (session?.isPaused) return { status: 'paused', source: 'browser' };
  if (session?.isActive) return { status: 'recording', source: 'browser' };
  if (session) return { status: 'idle', source: 'browser' };
  const player = await getMpchcState();
  if (!player.session) return { status: 'idle', source: 'player' };
  if (player.status === 'playing') return { status: 'recording', source: 'player' };
  if (player.status === 'paused') return { status: 'paused', source: 'player' };
  return { status: 'idle', source: 'player' };
}

export function scheduleStatusBadgeUpdate(): void {
  if (badgeUpdateTimer) clearTimeout(badgeUpdateTimer);
  badgeUpdateTimer = setTimeout(async () => {
    badgeUpdateTimer = null;
    await updateStatusBadge();
  }, 300);
}

export async function updateStatusBadge(): Promise<void> {
  if (!loadSettingsFn) return;
  const settings = await loadSettingsFn();
  if (!settings.enabled) {
    try {
      badgeApi.setBadgeText({ text: 'OFF' });
      badgeApi.setBadgeBackgroundColor({ color: '#6b7280' });
      badgeApi.setTitle({ title: 'jp343 - Tracking disabled' });
    } catch { /* badge unavailable on mobile */ }
    return;
  }

  const { status, source } = await getCurrentStatus();
  const suffix = source === 'player' ? ' (MPC-HC)' : '';

  try {
    switch (status) {
      case 'recording':
        badgeApi.setBadgeText({ text: '●' });
        badgeApi.setBadgeBackgroundColor({ color: '#22c55e' });
        badgeApi.setTitle({ title: `jp343 - Recording...${suffix}` });
        break;

      case 'paused':
        badgeApi.setBadgeText({ text: '❚❚' });
        badgeApi.setBadgeBackgroundColor({ color: '#f59e0b' });
        badgeApi.setTitle({ title: `jp343 - Paused${suffix}` });
        break;

      case 'ad':
        badgeApi.setBadgeText({ text: 'AD' });
        badgeApi.setBadgeBackgroundColor({ color: '#6b7280' });
        badgeApi.setTitle({ title: 'jp343 - Ad playing (not tracking)' });
        break;

      case 'idle':
      default:
        badgeApi.setBadgeText({ text: '' });
        badgeApi.setTitle({ title: 'jp343 Streaming Tracker' });
        break;
    }
  } catch { /* badge unavailable on mobile */ }
}

export function updateBadge(): void {
  scheduleStatusBadgeUpdate();
}
