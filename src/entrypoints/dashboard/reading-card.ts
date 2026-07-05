import type { MokuroState, PendingEntry, ExtensionStats } from '../../types';
import { STORAGE_KEYS, DEFAULT_MOKURO_STATE, DEFAULT_SETTINGS, DEFAULT_STATS } from '../../types';
import { getLocalDateString, formatStatDuration } from '../../lib/format-utils';
import { isReading } from '../../lib/time-tracker';
import { hasMokuroPermission, requestMokuroPermission } from './mokuro-permission';

const MYHUB_URL = 'https://jp343.com/my-hub/?src=ext_reading';

interface ReadingView {
  state: MokuroState;
  entries: PendingEntry[];
  readingDaily: Record<string, number>;
  dayStartHour: number;
}

function isFallbackName(name: string): boolean {
  return /^Mokuro [0-9a-f]{8}$/i.test(name);
}

async function loadView(): Promise<ReadingView | null> {
  const res = await browser.storage.local.get([
    STORAGE_KEYS.MOKURO, STORAGE_KEYS.PENDING, STORAGE_KEYS.STATS, STORAGE_KEYS.SETTINGS
  ]);
  const stored = res[STORAGE_KEYS.MOKURO] as Partial<MokuroState> | undefined;
  const state: MokuroState = { ...DEFAULT_MOKURO_STATE, ...(stored || {}) };
  const all = (res[STORAGE_KEYS.PENDING] as PendingEntry[] | undefined) || [];
  const entries = all.filter(isReading);
  const stats = (res[STORAGE_KEYS.STATS] as ExtensionStats | undefined) || DEFAULT_STATS;
  const readingDaily = stats.readingDailyMinutes ?? {};

  const durableReadingMin = Object.values(readingDaily).reduce((sum, m) => sum + m, 0);
  if (durableReadingMin <= 0 && state.totalMinutes <= 0 && entries.length === 0 && !state.enabled) return null;

  const settings = { ...DEFAULT_SETTINGS, ...(res[STORAGE_KEYS.SETTINGS] || {}) };
  return { state, entries, readingDaily, dayStartHour: settings.dayStartHour || 0 };
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function tile(value: string, label: string, sub: string): HTMLElement {
  const card = el('div', 'qs-card');
  card.appendChild(el('div', 'qs-value', value));
  card.appendChild(el('div', 'qs-label', label));
  card.appendChild(el('div', 'reading-sub', sub));
  return card;
}

function shiftDay(today: string, deltaDays: number): string {
  const d = new Date(today + 'T12:00:00');
  d.setDate(d.getDate() + deltaDays);
  return getLocalDateString(d, 0);
}

function lastDays(daily: Record<string, number>, today: string, count: number): number[] {
  const vals: number[] = [];
  for (let i = count - 1; i >= 0; i--) vals.push(daily[shiftDay(today, -i)] ?? 0);
  return vals;
}

function buildSparkline(daily: Record<string, number>, today: string): HTMLElement {
  const wrap = el('div', 'reading-spark-wrap');
  const vals = lastDays(daily, today, 7);
  const spark = el('div', 'reading-spark');
  const max = Math.max(1, ...vals);
  for (const v of vals) {
    const bar = el('div', 'bar' + (v === 0 ? ' empty' : ''));
    bar.style.height = Math.round((v / max) * 100) + '%';
    spark.appendChild(bar);
  }
  wrap.appendChild(spark);
  wrap.appendChild(el('div', 'reading-spark-cap', 'Last 7 days'));
  return wrap;
}

interface SeriesAgg { minutes: number; chars: number; label: string; latest: number; }

function buildSeriesList(entries: PendingEntry[]): HTMLElement {
  const box = el('div', 'reading-series');
  box.appendChild(el('div', 'reading-series-title', 'Recently read (this device)'));

  const byId: Record<string, SeriesAgg> = {};
  for (const e of entries) {
    const ts = new Date(e.date).getTime();
    const agg = byId[e.project_id] ?? { minutes: 0, chars: 0, label: '', latest: -1 };
    agg.minutes += e.duration_min;
    agg.chars += e.chars ?? 0;
    if (e.project && !isFallbackName(e.project) && ts >= agg.latest) {
      agg.label = e.project;
      agg.latest = ts;
    }
    byId[e.project_id] = agg;
  }
  const rows = Object.entries(byId).sort((a, b) => b[1].minutes - a[1].minutes).slice(0, 6);

  if (rows.length === 0) {
    box.appendChild(el('div', 'reading-empty', 'No recent reads on this device.'));
    return box;
  }

  const list = el('div', 'reading-series-list');
  for (const [, agg] of rows) {
    const item = el('div', 'reading-series-item');
    item.appendChild(el('span', 'reading-series-name', agg.label || 'Reading'));
    const meta = el('span', 'reading-series-meta');
    meta.appendChild(el('span', 'reading-series-min', formatStatDuration(agg.minutes)));
    if (agg.chars > 0) {
      meta.appendChild(el('span', 'reading-series-chars', agg.chars.toLocaleString('en-US') + ' chars'));
      if (agg.minutes > 0) {
        meta.appendChild(el('span', 'reading-series-speed', Math.round(agg.chars / agg.minutes) + ' chars/min'));
      }
    }
    item.appendChild(meta);
    list.appendChild(item);
  }
  box.appendChild(list);
  return box;
}

function buildPermissionWarning(): HTMLElement {
  const box = el('div', 'reading-warning');
  box.appendChild(el('span', 'reading-warning-text', 'Mokuro tracking is paused. Access to reader.mokuro.app was turned off.'));
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mokuro-regrant-btn';
  btn.textContent = 'Re-allow access';
  btn.addEventListener('click', async () => {
    if (await requestMokuroPermission()) await renderReadingCard();
  });
  box.appendChild(btn);
  return box;
}

export async function renderReadingCard(): Promise<void> {
  const card = document.getElementById('readingCard');
  const body = document.getElementById('readingCardBody');
  if (!card || !body) return;

  const view = await loadView();
  if (!view) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  body.textContent = '';

  const { state, entries, readingDaily, dayStartHour } = view;

  if (state.enabled && !(await hasMokuroPermission())) {
    body.appendChild(buildPermissionWarning());
  }
  const today = getLocalDateString(new Date(), dayStartHour);
  const todayMin = readingDaily[today] ?? 0;
  const weekMin = lastDays(readingDaily, today, 7).reduce((sum, m) => sum + m, 0);
  const hasMokuro = state.totalMinutes > 0;
  const totalChars = state.totalChars ?? 0;
  const speed = hasMokuro ? Math.round(totalChars / state.totalMinutes) : 0;

  const grid = el('div', 'reading-grid');
  grid.appendChild(tile(formatStatDuration(todayMin), 'Read today', 'all sources'));
  grid.appendChild(tile(formatStatDuration(weekMin), 'Last 7 days', 'all sources'));
  if (hasMokuro) {
    grid.appendChild(tile(totalChars.toLocaleString('en-US'), 'Characters', 'Mokuro'));
    grid.appendChild(tile(speed > 0 ? String(speed) : '—', 'chars/min', speed > 0 ? 'Mokuro speed' : 'no timed reading yet'));
  }
  body.appendChild(grid);

  body.appendChild(buildSparkline(readingDaily, today));
  body.appendChild(buildSeriesList(entries));

  const link = document.createElement('a');
  link.className = 'reading-myhub-link';
  link.href = MYHUB_URL;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Full reading stats on jp343.com';
  body.appendChild(link);
}
