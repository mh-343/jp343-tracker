import type { ExtensionStats } from '../../types';
import { formatStatDuration, getLocalDateString, getWeekDates } from '../../lib/format-utils';
import type { ServerStatsResponse } from './api';

export const CACHED_SERVER_STATS_KEY = 'jp343_cached_server_stats';

let _localDailyMinutes: Record<string, number> = {};

export function setLocalDailyMinutes(dm: Record<string, number>): void {
  _localDailyMinutes = dm;
}

export function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove('skeleton');
    el.textContent = text;
  }
}

export function renderHeroTime(totalMinutes: number): void {
  const el = document.getElementById('heroTime');
  if (!el) return;
  el.classList.remove('skeleton');
  const totalSec = Math.round(totalMinutes * 60);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  el.textContent = '';

  const hNum = document.createElement('span');
  hNum.className = 'num';
  hNum.textContent = String(h);
  el.appendChild(hNum);

  const hUnit = document.createElement('span');
  hUnit.className = 'unit';
  hUnit.textContent = 'hr';
  el.appendChild(hUnit);

  const mNum = document.createElement('span');
  mNum.className = 'num';
  mNum.textContent = ` ${m}`;
  el.appendChild(mNum);

  const mUnit = document.createElement('span');
  mUnit.className = 'unit';
  mUnit.textContent = 'min';
  el.appendChild(mUnit);
}

export function renderStats(stats: ExtensionStats): void {
  const todayStr = getLocalDateString();
  const todayMin = stats.dailyMinutes[todayStr] || 0;

  const weekDates = getWeekDates();
  const weekMin = weekDates.reduce((sum, d) => sum + (stats.dailyMinutes[d.date] || 0), 0);

  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthMin = Object.entries(stats.dailyMinutes)
    .filter(([date]) => date.startsWith(monthPrefix))
    .reduce((sum, [, min]) => sum + min, 0);

  setText('statToday', formatStatDuration(todayMin));
  setText('statWeek', formatStatDuration(weekMin));
  setText('statMonth', formatStatDuration(monthMin));
  setText('statStreak', `${stats.currentStreak}d`);
  renderHeroTime(stats.totalMinutes);

  const activeDays = Object.values(stats.dailyMinutes).filter(m => m > 0).length;
  if (activeDays > 0) {
    const dailyAvg = stats.totalMinutes / activeDays;
    setText('statDailyAvg', formatStatDuration(Math.round(dailyAvg)));

    const activeWeeks = new Set<string>();
    for (const date of Object.keys(stats.dailyMinutes)) {
      if (stats.dailyMinutes[date] > 0) {
        const d = new Date(date + 'T00:00:00');
        const weekStart = new Date(d);
        weekStart.setDate(d.getDate() - d.getDay());
        activeWeeks.add(weekStart.toISOString().slice(0, 10));
      }
    }
    if (activeWeeks.size > 0) {
      setText('statWeeklyAvg', formatStatDuration(Math.round(stats.totalMinutes / activeWeeks.size)));
    }

    const activeMonths = new Set<string>();
    for (const date of Object.keys(stats.dailyMinutes)) {
      if (stats.dailyMinutes[date] > 0) {
        activeMonths.add(date.slice(0, 7));
      }
    }
    if (activeMonths.size > 0) {
      setText('statMonthlyAvg', formatStatDuration(Math.round(stats.totalMinutes / activeMonths.size)));
    }

    const bestDay = Math.max(...Object.values(stats.dailyMinutes));
    if (bestDay > 0) {
      setText('statBestDay', formatStatDuration(Math.round(bestDay)));
    }
  }
}

export function renderHeatmap(dailyMinutes: Record<string, number>): void {
  const container = document.getElementById('heatmap');
  if (!container) return;
  container.textContent = '';

  const today = new Date();
  const todayDayOfWeek = (today.getDay() + 6) % 7;
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const WEEKS = 52;

  const startDate = new Date(today);
  startDate.setDate(today.getDate() - todayDayOfWeek - 51 * 7);

  const allWeeks: { date: Date; dateStr: string }[][] = [];
  for (let w = 0; w < WEEKS; w++) {
    const week: { date: Date; dateStr: string }[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(startDate);
      date.setDate(startDate.getDate() + w * 7 + d);
      week.push({ date, dateStr: getLocalDateString(date) });
    }
    allWeeks.push(week);
  }

  const groupMap = new Map<string, { label: string; weeks: typeof allWeeks }>();
  allWeeks.forEach(week => {
    const mon = week[0].date;
    const key = `${mon.getFullYear()}-${mon.getMonth()}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, { label: MONTH_NAMES[mon.getMonth()], weeks: [] });
    }
    groupMap.get(key)!.weeks.push(week);
  });

  const body = document.createElement('div');
  body.className = 'heatmap-body';

  const dayLabelsEl = document.createElement('div');
  dayLabelsEl.className = 'heatmap-day-labels';
  dayLabelsEl.appendChild(document.createElement('span'));
  ['Mo', '', 'Mi', '', 'Fr', '', ''].forEach(label => {
    const span = document.createElement('span');
    span.textContent = label;
    dayLabelsEl.appendChild(span);
  });
  dayLabelsEl.appendChild(document.createElement('span'));

  const monthsRow = document.createElement('div');
  monthsRow.className = 'heatmap-months-row';

  groupMap.forEach(({ label, weeks }) => {
    const group = document.createElement('div');
    group.className = 'heatmap-month-group';

    const labelEl = document.createElement('span');
    labelEl.className = 'heatmap-month-label';
    labelEl.textContent = label;

    const grid = document.createElement('div');
    grid.className = 'heatmap-month-grid';

    let activeDays = 0;

    weeks.forEach(week => {
      week.forEach(({ date, dateStr }) => {
        const cell = document.createElement('div');
        cell.className = 'heatmap-cell';

        if (date > today) {
          cell.style.visibility = 'hidden';
        } else {
          const minutes = dailyMinutes[dateStr] || 0;
          if (minutes > 0) activeDays++;
          const level = minutes === 0 ? 0 : minutes < 30 ? 1 : minutes < 60 ? 2 : minutes < 120 ? 3 : 4;
          cell.dataset.level = String(level);
          cell.title = `${dateStr}: ${formatStatDuration(minutes)}`;
          cell.setAttribute('aria-label', `${dateStr}: ${formatStatDuration(minutes)}`);
        }
        grid.appendChild(cell);
      });
    });

    const activeEl = document.createElement('span');
    activeEl.className = 'heatmap-month-active' + (activeDays > 0 ? ' has-data' : '');
    activeEl.textContent = activeDays > 0 ? `${activeDays}d` : '';
    activeEl.title = activeDays > 0 ? `${activeDays} active days` : 'No activity';

    group.appendChild(labelEl);
    group.appendChild(grid);
    group.appendChild(activeEl);
    monthsRow.appendChild(group);
  });

  body.appendChild(dayLabelsEl);
  body.appendChild(monthsRow);
  container.appendChild(body);
}

export function renderWeekBars(dailyMinutes: Record<string, number>): void {
  const container = document.getElementById('weekBars');
  if (!container) return;
  container.textContent = '';

  const days = getWeekDates();
  const maxMin = Math.max(1, ...days.map(d => dailyMinutes[d.date] || 0));
  const BAR_MAX_PX = 64;

  for (const day of days) {
    const min = dailyMinutes[day.date] || 0;
    const heightPx = Math.max(2, Math.round((min / maxMin) * BAR_MAX_PX));

    const col = document.createElement('div');
    col.className = 'week-bar-col';

    const value = document.createElement('div');
    value.className = 'week-bar-value';
    value.textContent = min > 0 ? formatStatDuration(min) : '';

    const bar = document.createElement('div');
    bar.className = `week-bar${day.isToday ? ' today' : ''}`;
    bar.style.height = `${heightPx}px`;

    const label = document.createElement('div');
    label.className = 'week-bar-label';
    label.textContent = day.label;

    col.appendChild(value);
    col.appendChild(bar);
    col.appendChild(label);
    container.appendChild(col);
  }
}

export function renderMonthBars(dailyMinutes: Record<string, number>): void {
  const container = document.getElementById('monthBars');
  if (!container) return;
  container.textContent = '';

  const now = new Date();
  const months: { key: string; label: string; minutes: number; isCurrent: boolean }[] = [];
  const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = d.getFullYear();
    const month = d.getMonth();
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;

    let total = 0;
    for (const [date, min] of Object.entries(dailyMinutes)) {
      if (date.startsWith(prefix)) total += min;
    }

    months.push({ key: prefix, label: monthLabels[month], minutes: total, isCurrent: i === 0 });
  }

  const maxMin = Math.max(1, ...months.map(m => m.minutes));
  const BAR_MAX_PX = 64;

  for (const month of months) {
    const heightPx = Math.max(2, Math.round((month.minutes / maxMin) * BAR_MAX_PX));

    const col = document.createElement('div');
    col.className = 'month-bar-col';

    const value = document.createElement('div');
    value.className = 'month-bar-value';
    value.textContent = month.minutes > 0 ? formatStatDuration(month.minutes) : '';

    const bar = document.createElement('div');
    bar.className = `month-bar${month.isCurrent ? ' current' : ''}`;
    bar.style.height = `${heightPx}px`;

    const label = document.createElement('div');
    label.className = 'month-bar-label';
    label.textContent = month.label;

    col.appendChild(value);
    col.appendChild(bar);
    col.appendChild(label);
    container.appendChild(col);
  }
}

function mergeDailyMinutes(
  local: Record<string, number>,
  server: Record<string, number>
): Record<string, number> {
  const merged: Record<string, number> = { ...server };
  for (const [date, localMin] of Object.entries(local)) {
    if (localMin > (merged[date] ?? 0)) merged[date] = localMin;
  }
  return merged;
}

function applyDerivedStats(dailyMinutes: Record<string, number>): void {
  const now = new Date();
  const thisMonthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  let totalMin = 0;
  let monthMin = 0;
  let bestDay = 0;
  const activeWeeks = new Set<string>();
  const activeMonths = new Set<string>();

  for (const [date, min] of Object.entries(dailyMinutes)) {
    if (min <= 0) continue;
    totalMin += min;
    if (date.startsWith(thisMonthPrefix)) monthMin += min;
    if (min > bestDay) bestDay = min;
    const d = new Date(date + 'T12:00:00');
    const startOfYear = new Date(d.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((d.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
    activeWeeks.add(`${d.getFullYear()}-W${weekNum}`);
    activeMonths.add(date.slice(0, 7));
  }

  setText('statMonth', formatStatDuration(monthMin));
  setText('statBestDay', formatStatDuration(bestDay));
  if (activeWeeks.size > 0)
    setText('statWeeklyAvg', formatStatDuration(Math.round(totalMin / activeWeeks.size)));
  if (activeMonths.size > 0)
    setText('statMonthlyAvg', formatStatDuration(Math.round(totalMin / activeMonths.size)));
}

export function applyServerStats(serverData: ServerStatsResponse): void {
  if (serverData.total_seconds !== undefined) {
    renderHeroTime(serverData.total_seconds / 60);
  }
  if (serverData.week_seconds !== undefined) {
    setText('statWeek', formatStatDuration(serverData.week_seconds / 60));
  }
  if (serverData.today_seconds !== undefined) {
    setText('statToday', formatStatDuration(serverData.today_seconds / 60));
  }
  if (serverData.streak !== undefined) {
    setText('statStreak', `${serverData.streak}d`);
  }
  if (serverData.daily_avg_seconds !== undefined) {
    setText('statDailyAvg', formatStatDuration(serverData.daily_avg_seconds / 60));
  }
  if (serverData.daily_minutes) {
    const merged = mergeDailyMinutes(_localDailyMinutes, serverData.daily_minutes);
    renderHeatmap(merged);
    renderWeekBars(merged);
    renderMonthBars(merged);
    applyDerivedStats(merged);
  }
  browser.storage.local.set({ [CACHED_SERVER_STATS_KEY]: serverData });
}

export async function applyCachedServerStats(): Promise<void> {
  const cached = (await browser.storage.local.get(CACHED_SERVER_STATS_KEY))[CACHED_SERVER_STATS_KEY];
  if (cached) {
    applyServerStats(cached);
  }
}
