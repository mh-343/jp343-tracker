import type { ExtensionSettings, ExtensionStats } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { getLocalDateString, getLogicalNow } from '../format-utils';

export async function maybeFireStreakRiskNotification(
  loadSettings: () => Promise<ExtensionSettings>,
  loadStats: () => Promise<ExtensionStats>
): Promise<void> {
  if (typeof browser.notifications?.create !== 'function') return;

  const settings = await loadSettings();
  if (!settings.streakRiskNotification) return;
  const stats = await loadStats();
  if (stats.currentStreak <= 0) return;

  const dsh = settings.dayStartHour || 0;
  const logicalNow = getLogicalNow(dsh);
  const today = getLocalDateString(logicalNow);
  const dayBeforeYesterday = new Date(logicalNow);
  dayBeforeYesterday.setDate(dayBeforeYesterday.getDate() - 2);
  const dayBeforeYesterdayStr = getLocalDateString(dayBeforeYesterday);

  if (stats.lastActiveDate !== dayBeforeYesterdayStr) return;
  if ((stats.dailyMinutes[today] || 0) > 0) return;

  // evening only, not right after midnight
  const REMINDER_START_HOUR = 18;
  if (logicalNow.getHours() < REMINDER_START_HOUR) return;

  const guardKey = STORAGE_KEYS.STREAK_RISK_NOTIF_DATE;
  const guard = await browser.storage.local.get(guardKey);
  if (guard[guardKey] === today) return;

  await browser.notifications.create('jp343-streak-risk', {
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/icon-128.png'),
    title: 'Streak at risk!',
    message: `Log today to keep your ${stats.currentStreak}-day streak`
  });
  await browser.storage.local.set({ [guardKey]: today });
}
