import { tracker } from './time-tracker';
import type { ExtensionSettings } from '../types';

const badgeApi = browser.action ?? browser.browserAction;

type TrackingStatus = 'recording' | 'paused' | 'ad' | 'idle';

let loadSettingsFn: (() => Promise<ExtensionSettings>) | null = null;
let badgeUpdateTimer: ReturnType<typeof setTimeout> | null = null;

export function initBadgeService(loadSettings: () => Promise<ExtensionSettings>): void {
  loadSettingsFn = loadSettings;
}

function getCurrentStatus(): TrackingStatus {
  if (tracker.isAdPlaying()) return 'ad';
  const session = tracker.getCurrentSession();
  if (!session) return 'idle';
  if (session.isPaused) return 'paused';
  if (session.isActive) return 'recording';
  return 'idle';
}

export function scheduleStatusBadgeUpdate(): void {
  if (badgeUpdateTimer) return;
  badgeUpdateTimer = setTimeout(async () => {
    badgeUpdateTimer = null;
    await updateStatusBadge();
  }, 500);
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

  const status = getCurrentStatus();

  try {
    switch (status) {
      case 'recording':
        badgeApi.setBadgeText({ text: '●' });
        badgeApi.setBadgeBackgroundColor({ color: '#22c55e' });
        badgeApi.setTitle({ title: 'jp343 - Recording...' });
        break;

      case 'paused':
        badgeApi.setBadgeText({ text: '❚❚' });
        badgeApi.setBadgeBackgroundColor({ color: '#f59e0b' });
        badgeApi.setTitle({ title: 'jp343 - Paused' });
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
