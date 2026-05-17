import type { PendingEntry } from '../../types';
import { formatStatDuration, getLocalDateString } from '../../lib/format-utils';

const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

let _targetStartTimes: (string | null)[] = [null, null, null, null, null, null, null];
let _localFirstSessions: Record<string, string> = {};
let _dayStartHour = 0;

export function setTargetStartTimes(times: (string | null)[]): void {
  _targetStartTimes = times;
}

export function setLocalFirstSessions(sessions: Record<string, string>): void {
  _localFirstSessions = sessions;
}

export function setDayStartHourForTargetStart(hour: number): void {
  _dayStartHour = hour;
}

export function mergeFirstSessions(
  server: Record<string, string>,
  local: Record<string, string>,
  dayStartHour = 0
): Record<string, string> {
  const merged: Record<string, string> = { ...server };
  for (const [key, time] of Object.entries(local)) {
    if (!merged[key] || logicalMinutes(time, dayStartHour) < logicalMinutes(merged[key], dayStartHour)) {
      merged[key] = time;
    }
  }
  return merged;
}

function logicalMinutes(time: string, dayStartHour: number): number {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m;
  return dayStartHour > 0 && h < dayStartHour ? total + 1440 : total;
}

function computeDeviation(target: string, actual: string): number {
  const [th, tm] = target.split(':').map(Number);
  const [ah, am] = actual.split(':').map(Number);
  if (_dayStartHour > 0) {
    const bm = _dayStartHour * 60;
    const tMin = th * 60 + tm < bm ? th * 60 + tm + 1440 : th * 60 + tm;
    const aMin = ah * 60 + am < bm ? ah * 60 + am + 1440 : ah * 60 + am;
    return aMin - tMin;
  }
  let dev = (ah * 60 + am) - (th * 60 + tm);
  if (dev > 720) dev -= 1440;
  if (dev < -720) dev += 1440;
  return dev;
}

function getDateKeyWeekday(dateKey: string): number {
  return new Date(dateKey + 'T12:00').getDay();
}

function getLast14DateKeys(): string[] {
  const keys: string[] = [];
  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    keys.push(getLocalDateString(d, _dayStartHour));
  }
  return keys;
}

export function computeLocalFirstSessions(entries: PendingEntry[], dayStartHour = 0): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.date) continue;
    const d = new Date(entry.date);
    const key = getLocalDateString(d, dayStartHour);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (!result[key] || logicalMinutes(time, dayStartHour) < logicalMinutes(result[key], dayStartHour)) {
      result[key] = time;
    }
  }
  return result;
}

export function renderTargetStartChart(firstSessions: Record<string, string>): void {
  const card = document.getElementById('targetStartCard');
  const chartContainer = document.getElementById('targetStartChart');
  const statsContainer = document.getElementById('targetStartStats');
  if (!card || !chartContainer || !statsContainer) return;

  const hasAnyTarget = _targetStartTimes.some(t => t !== null);
  if (!hasAnyTarget) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  chartContainer.textContent = '';
  statsContainer.textContent = '';

  const dateKeys = getLast14DateKeys();
  const deviations: number[] = [];
  const BAR_MAX_PX = 40;

  const centerLine = document.createElement('div');
  centerLine.className = 'target-start-center';

  const barsWrap = document.createElement('div');
  barsWrap.className = 'target-start-bars';

  for (const key of dateKeys) {
    const weekday = getDateKeyWeekday(key);
    const target = _targetStartTimes[weekday];
    const actual = firstSessions[key];

    const col = document.createElement('div');
    col.className = 'target-start-bar-col';

    const barArea = document.createElement('div');
    barArea.className = 'target-start-bar-area';

    let devValue: number | null = null;

    if (!target) {
      const dot = document.createElement('div');
      dot.className = 'target-start-dot';
      col.title = `${key} (no target)`;
      barArea.appendChild(dot);
    } else if (!actual) {
      const dot = document.createElement('div');
      dot.className = 'target-start-dot missed';
      col.title = `${key} (no session)`;
      barArea.appendChild(dot);
    } else {
      const dev = computeDeviation(target, actual);
      deviations.push(dev);
      devValue = dev;

      const bar = document.createElement('div');
      bar.className = 'target-start-bar ' + (dev <= 0 ? 'early' : 'late');
      const absDev = Math.abs(dev);
      const devFormatted = absDev >= 60 ? formatStatDuration(absDev) : `${absDev} min`;
      col.title = `${key}: started ${actual}, ${devFormatted} ${dev <= 0 ? 'early' : 'late'} (target ${target})`;

      barArea.appendChild(bar);
      bar.dataset.dev = String(dev);
    }

    const label = document.createElement('div');
    label.className = 'target-start-label';
    label.textContent = WEEKDAY_LETTERS[weekday];

    const devLabel = document.createElement('div');
    devLabel.className = 'target-start-dev';
    if (devValue !== null) {
      const displayVal = -devValue;
      const abs = Math.abs(displayVal);
      const formatted = abs >= 60 ? formatStatDuration(abs) : `${abs}m`;
      devLabel.textContent = displayVal === 0 ? '0' : (displayVal > 0 ? `+${formatted}` : `-${formatted}`);
      devLabel.classList.add(displayVal === 0 ? 'on-time' : displayVal > 0 ? 'early' : 'late');
    }

    col.appendChild(barArea);
    col.appendChild(label);
    col.appendChild(devLabel);
    barsWrap.appendChild(col);
  }

  const maxAbsDev = Math.max(1, ...Array.from(barsWrap.querySelectorAll('.target-start-bar')).map(
    el => Math.abs(Number((el as HTMLElement).dataset.dev || 0))
  ));

  for (const bar of barsWrap.querySelectorAll('.target-start-bar') as NodeListOf<HTMLElement>) {
    const dev = Number(bar.dataset.dev || 0);
    const heightPx = Math.max(2, Math.round((Math.abs(dev) / maxAbsDev) * BAR_MAX_PX));
    bar.style.height = `${heightPx}px`;
    if (dev <= 0) {
      bar.style.bottom = '50%';
    } else {
      bar.style.top = '50%';
    }
  }

  chartContainer.appendChild(barsWrap);

  if (deviations.length === 0) {
    statsContainer.textContent = 'No matching sessions in the last 14 days';
    statsContainer.className = 'target-start-stats empty';
    return;
  }

  const mean = Math.round(deviations.reduce((a, b) => a + b, 0) / deviations.length);
  const sorted = [...deviations].sort((a, b) => a - b);
  const median = sorted.length % 2 === 0
    ? Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
    : sorted[Math.floor(sorted.length / 2)];

  function formatDev(min: number): string {
    const abs = Math.abs(min);
    const label = min <= 0 ? 'early' : 'late';
    return abs === 0 ? 'on time' : `${formatStatDuration(abs)} ${label}`;
  }

  statsContainer.className = 'target-start-stats';
  const meanEl = document.createElement('span');
  meanEl.textContent = `Average: ${formatDev(mean)}`;
  const medianEl = document.createElement('span');
  medianEl.textContent = `Median: ${formatDev(median)}`;
  statsContainer.appendChild(meanEl);
  statsContainer.appendChild(medianEl);
}

export function renderTargetStartFromLocal(entries: PendingEntry[]): void {
  const local = computeLocalFirstSessions(entries, _dayStartHour);
  renderTargetStartChart(local);
}
