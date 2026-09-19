import type { ReaderState, PendingEntry, ExtensionStats } from '../../types';
import { STORAGE_KEYS, DEFAULT_READER_STATE, DEFAULT_SETTINGS, DEFAULT_STATS } from '../../types';
import { getLocalDateString, formatStatDuration } from '../../lib/format-utils';
import { isReading } from '../../lib/time-tracker';
import type { ReaderSource } from '../../lib/reader-sources';
import { READER_SOURCE_LIST, readerOriginHost } from '../../lib/reader-sources';
import { hasReaderPermission, requestReaderPermission } from './reader-permission';
import type { ServerReadingStatsResponse } from './api';

const MYHUB_URL = 'https://jp343.com/my-hub/?src=ext_reading';

let serverReadingStats: ServerReadingStatsResponse | null = null;

export function setServerReadingStats(stats: ServerReadingStatsResponse | null): void {
  serverReadingStats = stats;
}

let readingRenderGen = 0;

function sumRecentDaily(daily: { day: string; minutes: number }[] | undefined, days: number): number {
  if (!daily || daily.length === 0) return 0;
  return daily.slice(-days).reduce((sum, d) => sum + (d.minutes || 0), 0);
}

interface SourceState {
  source: ReaderSource;
  state: ReaderState;
}

interface ReadingView {
  states: SourceState[];
  entries: PendingEntry[];
  readingDaily: Record<string, number>;
  dayStartHour: number;
}

function isFallbackName(name: string): boolean {
  return READER_SOURCE_LIST.some(s => s.fallbackNameRe.test(name));
}

async function loadView(): Promise<ReadingView | null> {
  const keys = [
    STORAGE_KEYS.PENDING, STORAGE_KEYS.STATS, STORAGE_KEYS.SETTINGS,
    ...READER_SOURCE_LIST.map(s => s.stateKey)
  ];
  const res = await browser.storage.local.get(keys);
  const states: SourceState[] = READER_SOURCE_LIST.map(source => {
    const stored = res[source.stateKey] as Partial<ReaderState> | undefined;
    return { source, state: { ...DEFAULT_READER_STATE, ...(stored || {}) } };
  });
  const all = (res[STORAGE_KEYS.PENDING] as PendingEntry[] | undefined) || [];
  const entries = all.filter(isReading);
  const stats = (res[STORAGE_KEYS.STATS] as ExtensionStats | undefined) || DEFAULT_STATS;
  const readingDaily = stats.readingDailyMinutes ?? {};

  const durableReadingMin = Object.values(readingDaily).reduce((sum, m) => sum + m, 0);
  const anyEnabled = states.some(s => s.state.enabled);
  const anyTotalMinutes = states.some(s => s.state.totalMinutes > 0);
  if (durableReadingMin <= 0 && !anyTotalMinutes && entries.length === 0 && !anyEnabled) return null;

  const settings = { ...DEFAULT_SETTINGS, ...(res[STORAGE_KEYS.SETTINGS] || {}) };
  return { states, entries, readingDaily, dayStartHour: settings.dayStartHour || 0 };
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

function buildSparklineFromVals(vals: number[]): HTMLElement {
  const wrap = el('div', 'reading-spark-wrap');
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

function buildPermissionWarning(source: ReaderSource): HTMLElement {
  const box = el('div', 'reading-warning');
  box.appendChild(el('span', 'reading-warning-text',
    `${source.label} tracking is paused. Access to ${readerOriginHost(source.origins[0])} was turned off.`));
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mokuro-regrant-btn';
  btn.textContent = 'Re-allow access';
  btn.addEventListener('click', async () => {
    if (await requestReaderPermission(source)) await renderReadingCard();
  });
  box.appendChild(btn);
  return box;
}

export async function renderReadingCard(): Promise<void> {
  const card = document.getElementById('readingCard');
  const body = document.getElementById('readingCardBody');
  if (!card || !body) return;

  const gen = ++readingRenderGen;
  const view = await loadView();
  if (gen !== readingRenderGen) return;

  const server = serverReadingStats;
  const serverHasData = !!server?.has_data;
  if (!view && !serverHasData) {
    card.style.display = 'none';
    return;
  }

  const states = view?.states ?? [];
  const entries = view?.entries ?? [];
  const readingDaily = view?.readingDaily ?? {};
  const dayStartHour = view?.dayStartHour ?? 0;

  const warnings: HTMLElement[] = [];
  for (const { source, state } of states) {
    if (state.enabled && !(await hasReaderPermission(source))) {
      warnings.push(buildPermissionWarning(source));
    }
  }
  if (gen !== readingRenderGen) return;

  const today = getLocalDateString(new Date(), dayStartHour);
  const localTotalMinutes = states.reduce((sum, s) => sum + (s.state.totalMinutes ?? 0), 0);
  const localTotalChars = states.reduce((sum, s) => sum + (s.state.totalChars ?? 0), 0);
  const localSpeed = localTotalMinutes > 0 ? Math.round(localTotalChars / localTotalMinutes) : 0;

  const useServer = serverHasData;
  const scopeSub = useServer ? 'all sources' : 'this browser';

  const todayMin = useServer ? (server!.today_minutes ?? 0) : (readingDaily[today] ?? 0);
  const weekMin = useServer
    ? sumRecentDaily(server!.daily, 7)
    : lastDays(readingDaily, today, 7).reduce((sum, m) => sum + m, 0);
  const totalChars = useServer ? (server!.total_chars ?? 0) : localTotalChars;
  const speed = useServer ? (server!.reading_speed ?? 0) : localSpeed;
  const showAggregates = useServer || localTotalMinutes > 0;

  card.style.display = '';
  body.textContent = '';
  for (const warning of warnings) body.appendChild(warning);

  const grid = el('div', 'reading-grid');
  grid.appendChild(tile(formatStatDuration(todayMin), 'Read today', scopeSub));
  grid.appendChild(tile(formatStatDuration(weekMin), 'Last 7 days', scopeSub));
  if (showAggregates) {
    grid.appendChild(tile(totalChars > 0 ? totalChars.toLocaleString('en-US') : '—', 'Characters', scopeSub));
    grid.appendChild(tile(speed > 0 ? String(speed) : '—', 'chars/min', speed > 0 ? scopeSub : 'no timed reading yet'));
  }
  body.appendChild(grid);

  const sparkVals = useServer
    ? (server!.daily ?? []).slice(-7).map(d => d.minutes || 0)
    : lastDays(readingDaily, today, 7);
  body.appendChild(buildSparklineFromVals(sparkVals));
  if (view) body.appendChild(buildSeriesList(entries));

  const link = document.createElement('a');
  link.className = 'reading-myhub-link';
  link.href = MYHUB_URL;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Full reading stats on jp343.com';
  body.appendChild(link);
}
