import type { ExtensionSettings, ExtensionStats } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { getLocalDateString, getLogicalNow } from '../format-utils';
import { stableUserId } from '../auth-helpers';
import { loadUserState, readOwnedServerStats } from '../server-cache';
import { tracker } from '../time-tracker';
import { getMpchcState } from './mpchc-poller';
import { isFromLogicalToday } from './activity-progress';

interface StreakServerView {
  streak?: number;
  daily_minutes?: Record<string, number>;
  cachedAt?: number;
}

// server cache covers other devices and the website
async function streakAtRisk(
  stats: ExtensionStats,
  dsh: number,
  today: string,
  dayBeforeYesterday: string
): Promise<number | null> {
  const envelope = await readOwnedServerStats(stableUserId(await loadUserState()));
  const server = envelope?.value as StreakServerView | undefined;
  const serverDays = server?.daily_minutes ?? {};

  if ((stats.dailyMinutes[today] || 0) > 0 || (serverDays[today] || 0) > 0) return null;

  let lastActive = stats.lastActiveDate || '';
  for (const [day, minutes] of Object.entries(serverDays)) {
    if (minutes > 0 && day > lastActive && day <= today) lastActive = day;
  }
  if (lastActive !== dayBeforeYesterday) return null;

  const serverStreak = server?.streak !== undefined && isFromLogicalToday(server.cachedAt, dsh) ? server.streak : 0;
  const streak = Math.max(stats.currentStreak, serverStreak);
  return streak > 0 ? streak : null;
}

export async function maybeFireStreakRiskNotification(
  loadSettings: () => Promise<ExtensionSettings>,
  loadStats: () => Promise<ExtensionStats>,
  refreshServerStats: () => Promise<void>
): Promise<void> {
  if (typeof browser.notifications?.create !== 'function') return;

  const settings = await loadSettings();
  if (!settings.streakRiskNotification) return;

  const dsh = settings.dayStartHour || 0;
  const logicalNow = getLogicalNow(dsh);
  const today = getLocalDateString(logicalNow);
  const dayBeforeYesterday = new Date(logicalNow);
  dayBeforeYesterday.setDate(dayBeforeYesterday.getDate() - 2);
  const dayBeforeYesterdayStr = getLocalDateString(dayBeforeYesterday);

  // evening only, not right after midnight
  const REMINDER_START_HOUR = 18;
  if (logicalNow.getHours() < REMINDER_START_HOUR) return;

  const guardKey = STORAGE_KEYS.STREAK_RISK_NOTIF_DATE;
  const guard = await browser.storage.local.get(guardKey);
  if (guard[guardKey] === today) return;

  // a running session saves into today
  if (tracker.getCurrentSession() || (await getMpchcState()).session) return;

  if (await streakAtRisk(await loadStats(), dsh, today, dayBeforeYesterdayStr) === null) return;
  await refreshServerStats().catch(() => {});
  const streak = await streakAtRisk(await loadStats(), dsh, today, dayBeforeYesterdayStr);
  if (streak === null) return;

  await browser.notifications.create('jp343-streak-risk', {
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/icon-128.png'),
    title: 'Streak at risk!',
    message: `Log today to keep your ${streak}-day streak`
  });
  await browser.storage.local.set({ [guardKey]: today });
}
