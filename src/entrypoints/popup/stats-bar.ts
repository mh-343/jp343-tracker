import { getWeekDates } from '../../lib/format-utils';
import type { createTodayLive } from './today-live';

const DEBUG_MODE = import.meta.env.DEV;
const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};

type TodayLive = ReturnType<typeof createTodayLive>;

export function renderWeekBars(dailyMinutes: Record<string, number>, dayStartHour: number): void {
  const container = document.getElementById('weekBars');
  if (!container) return;

  const days = getWeekDates(dayStartHour);
  const maxVal = Math.max(1, ...days.map(d => dailyMinutes[d.date] || 0));

  container.replaceChildren();
  for (const { date, label, isToday } of days) {
    const minutes = dailyMinutes[date] || 0;
    const heightPx = minutes > 0 ? Math.max(2, Math.round((minutes / maxVal) * 24)) : 2;

    const item = document.createElement('div');
    item.className = 'week-bar-item';

    const track = document.createElement('div');
    track.className = 'week-bar-track';

    const fill = document.createElement('div');
    fill.className = minutes === 0 ? 'week-bar-fill empty' : isToday ? 'week-bar-fill today' : 'week-bar-fill';
    fill.style.height = heightPx + 'px';

    const labelEl = document.createElement('span');
    labelEl.className = 'week-bar-label';
    labelEl.textContent = label;

    track.appendChild(fill);
    item.appendChild(track);
    item.appendChild(labelEl);
    container.appendChild(item);
  }

  container.style.display = 'flex';
}

export interface StatsBarOptions {
  statStreak: HTMLElement;
  todayLive: Pick<TodayLive, 'setBase'>;
}

export function createStatsBar(options: StatsBarOptions): { fetchAndRenderStats: () => Promise<void> } {
  let statsFetching = false;
  let statsRefreshQueued = false;

  async function fetchAndRenderStats(): Promise<void> {
    if (statsFetching) {
      statsRefreshQueued = true;
      return;
    }
    statsRefreshQueued = false;
    statsFetching = true;
    try {
      const response = await browser.runtime.sendMessage({ type: 'GET_STATS' });
      if (response?.success && response.data) {
        const { weekMinutes, todayMinutes, streak, rawDailyMinutes, todayByActivity, todayActiveMinutes } = response.data;
        options.statStreak.textContent = `${streak || 0}d`;
        options.todayLive.setBase({
          liveSessionId: response.data.liveSessionId,
          livePlayerSessionId: response.data.livePlayerSessionId ?? null,
          dayKey: response.data.dayKey,
          dayStartHour: response.data.dayStartHour,
          todayMinutes: todayMinutes || 0,
          weekMinutes: weekMinutes || 0,
          byActivity: todayByActivity || {},
          activeMinutes: todayActiveMinutes || 0,
          dailyMinutes: rawDailyMinutes || {}
        });
      }
    } catch (error) {
      log('[JP343 Popup] Stats fetch failed:', error);
    } finally {
      statsFetching = false;
      if (statsRefreshQueued) void fetchAndRenderStats();
    }
  }

  return { fetchAndRenderStats };
}
