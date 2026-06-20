import type { AnkiState, AnkiCollectionState, AnkiDay, AnkiStatus } from '../../types';
import { STORAGE_KEYS, DEFAULT_SETTINGS } from '../../types';
import { getLocalDateString, formatStatDuration } from '../../lib/format-utils';
import { recalculateStreak } from '../../lib/background/stats-managers';

interface AnkiView {
  state: AnkiState;
  col: AnkiCollectionState;
  dayStartHour: number;
}

async function loadView(): Promise<AnkiView | null> {
  const res = await browser.storage.local.get([STORAGE_KEYS.ANKI, STORAGE_KEYS.SETTINGS]);
  const state = res[STORAGE_KEYS.ANKI] as AnkiState | undefined;
  if (!state || !state.enabled) return null;
  const profile = state.activeCollection;
  const col = profile ? state.collections[profile] : undefined;
  if (!col || Object.keys(col.days).length === 0) return null;
  const settings = { ...DEFAULT_SETTINGS, ...(res[STORAGE_KEYS.SETTINGS] || {}) };
  return { state, col, dayStartHour: settings.dayStartHour || 0 };
}

function shiftDate(dateKey: string, deltaDays: number): string {
  const d = new Date(dateKey + 'T12:00:00');
  d.setDate(d.getDate() + deltaDays);
  return getLocalDateString(d, 0);
}

function sumField(col: AnkiCollectionState, field: keyof AnkiDay, fromDate?: string): number {
  let total = 0;
  for (const [date, day] of Object.entries(col.days)) {
    if (fromDate && date < fromDate) continue;
    total += day[field] || 0;
  }
  return total;
}

function el(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function tile(value: string, label: string): HTMLElement {
  const card = el('div', 'qs-card');
  const v = el('div', 'qs-value');
  v.textContent = value;
  const l = el('div', 'qs-label');
  l.textContent = label;
  card.appendChild(v);
  card.appendChild(l);
  return card;
}

// 30d window, else all-time, else n/a
function retentionTile(col: AnkiCollectionState, passField: keyof AnkiDay, totalField: keyof AnkiDay, from30: string, label: string): HTMLElement {
  const t30 = sumField(col, totalField, from30);
  if (t30 > 0) return tile(Math.round((sumField(col, passField, from30) / t30) * 100) + '%', `${label} 30d`);
  const tAll = sumField(col, totalField);
  if (tAll > 0) return tile(Math.round((sumField(col, passField) / tAll) * 100) + '%', `${label} all-time`);
  return tile('n/a', label);
}

function statusLabel(s: AnkiStatus): string {
  switch (s) {
    case 'unreachable': return 'Anki not running';
    case 'permission_needed': return 'Permission needed in Anki';
    case 'api_key_required': return 'AnkiConnect API key blocks sync';
    default: return 'Not connected';
  }
}

function buildPill(state: AnkiState, todayReviews: number): HTMLElement {
  const pill = el('div', 'anki-pill' + (state.status === 'connected' ? ' connected' : ''));
  pill.appendChild(el('span', 'dot'));
  const text = el('span');
  text.textContent = state.status === 'connected'
    ? `Connected · ${todayReviews} reviews today`
    : statusLabel(state.status);
  pill.appendChild(text);
  return pill;
}

function lastReviewDate(col: AnkiCollectionState): string | null {
  let last = '';
  for (const [date, day] of Object.entries(col.days)) {
    if (day.reviews > 0 && date > last) last = date;
  }
  return last || null;
}

function formatDate(dateKey: string): string {
  return new Date(dateKey + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function buildSparkline(col: AnkiCollectionState, today: string): HTMLElement {
  const vals: number[] = [];
  for (let i = 29; i >= 0; i--) vals.push(col.days[shiftDate(today, -i)]?.reviews ?? 0);

  if (vals.every(v => v === 0)) {
    const hint = el('div', 'anki-empty-hint');
    const last = lastReviewDate(col);
    hint.textContent = last
      ? `No reviews in the last 30 days · last: ${formatDate(last)}`
      : 'No reviews in the last 30 days';
    return hint;
  }

  const wrap = el('div', 'anki-spark');
  const max = Math.max(1, ...vals);
  for (const v of vals) {
    const bar = el('div', 'bar' + (v === 0 ? ' empty' : ''));
    bar.style.height = Math.round((v / max) * 100) + '%';
    wrap.appendChild(bar);
  }
  return wrap;
}

const TYPE_SEGMENTS: { key: keyof AnkiDay; cls: string; label: string }[] = [
  { key: 'learn', cls: 'learn', label: 'Learn' },
  { key: 'review', cls: 'review', label: 'Review' },
  { key: 'relearn', cls: 'relearn', label: 'Relearn' },
  { key: 'cram', cls: 'cram', label: 'Cram' }
];

function buildTypeSplit(col: AnkiCollectionState, fromDate: string): HTMLElement {
  const wrap = el('div', 'anki-typesplit');
  let counts = TYPE_SEGMENTS.map(s => sumField(col, s.key, fromDate));
  if (counts.reduce((a, b) => a + b, 0) === 0) counts = TYPE_SEGMENTS.map(s => sumField(col, s.key));
  const total = counts.reduce((a, b) => a + b, 0) || 1;

  const bar = el('div', 'anki-types');
  TYPE_SEGMENTS.forEach((s, i) => {
    if (counts[i] === 0) return;
    const seg = el('span', 'seg-' + s.cls);
    seg.style.width = Math.round((counts[i] / total) * 100) + '%';
    seg.title = `${s.label}: ${counts[i]}`;
    bar.appendChild(seg);
  });
  wrap.appendChild(bar);

  const legend = el('div', 'anki-legend');
  TYPE_SEGMENTS.forEach((s, i) => {
    if (counts[i] === 0) return;
    const item = el('span', 'anki-legend-item');
    item.appendChild(el('span', 'swatch seg-' + s.cls));
    const lbl = el('span');
    lbl.textContent = `${s.label} ${counts[i]}`;
    item.appendChild(lbl);
    legend.appendChild(item);
  });
  wrap.appendChild(legend);
  return wrap;
}

function latestSnapshot(col: AnkiCollectionState): { date: string; mature: number; young: number; new: number } | null {
  let best: { date: string; mature: number; young: number; new: number } | null = null;
  for (const [date, day] of Object.entries(col.days)) {
    if (typeof day.colMature === 'number' && typeof day.colYoung === 'number' && typeof day.colNew === 'number') {
      if (!best || date > best.date) best = { date, mature: day.colMature, young: day.colYoung, new: day.colNew };
    }
  }
  return best;
}

const MATURITY_SEGMENTS: { key: 'mature' | 'young' | 'new'; cls: string; label: string }[] = [
  { key: 'mature', cls: 'mature', label: 'Mature' },
  { key: 'young', cls: 'young', label: 'Young' },
  { key: 'new', cls: 'new', label: 'New' }
];

function buildMaturity(col: AnkiCollectionState, today: string): HTMLElement | null {
  const snap = latestSnapshot(col);
  if (!snap) return null;
  const wrap = el('div', 'anki-maturity');

  const hero = el('div', 'anki-words');
  const num = el('div', 'anki-words-num');
  num.textContent = snap.mature.toLocaleString();
  const lbl = el('div', 'anki-words-label');
  lbl.textContent = snap.date === today ? 'Words you know' : `Words you know · as of ${formatDate(snap.date)}`;
  hero.appendChild(num);
  hero.appendChild(lbl);
  wrap.appendChild(hero);

  const total = snap.mature + snap.young + snap.new || 1;
  const bar = el('div', 'anki-types');
  for (const seg of MATURITY_SEGMENTS) {
    const v = snap[seg.key];
    if (v === 0) continue;
    const s = el('span', 'mat-' + seg.cls);
    s.style.width = Math.round((v / total) * 100) + '%';
    s.title = `${seg.label}: ${v}`;
    bar.appendChild(s);
  }
  wrap.appendChild(bar);

  const legend = el('div', 'anki-legend');
  for (const seg of MATURITY_SEGMENTS) {
    const item = el('span', 'anki-legend-item');
    item.appendChild(el('span', 'swatch mat-' + seg.cls));
    const t = el('span');
    t.textContent = `${seg.label} ${snap[seg.key].toLocaleString()}`;
    item.appendChild(t);
    legend.appendChild(item);
  }
  wrap.appendChild(legend);
  return wrap;
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function buildSyncLine(col: AnkiCollectionState): HTMLElement | null {
  if (col.lastPushError) {
    const e = el('div', 'anki-subline');
    e.textContent = col.lastPushError === 'server_not_ready' ? 'Waiting for server update' : 'Sync failing';
    return e;
  }
  if (col.lastPushedAt) {
    const e = el('div', 'anki-subline');
    e.textContent = 'Last synced ' + timeAgo(col.lastPushedAt);
    return e;
  }
  return null;
}

export async function renderAnkiCard(): Promise<void> {
  const card = document.getElementById('ankiCard');
  const body = document.getElementById('ankiCardBody');
  if (!card || !body) return;

  const view = await loadView();
  if (!view) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  body.textContent = '';

  const { state, col, dayStartHour } = view;
  const today = getLocalDateString(new Date(), dayStartHour);
  const from7 = shiftDate(today, -6);
  const from30 = shiftDate(today, -29);

  const reviewsToday = col.days[today]?.reviews ?? 0;
  const reviews7 = sumField(col, 'reviews', from7);

  const reviewsMap: Record<string, number> = {};
  for (const [date, day] of Object.entries(col.days)) reviewsMap[date] = day.reviews;
  const streak = recalculateStreak(reviewsMap, dayStartHour);
  const totalTime = formatStatDuration(sumField(col, 'seconds') / 60);

  body.appendChild(buildPill(state, reviewsToday));

  const maturity = buildMaturity(col, today);
  if (maturity) body.appendChild(maturity);

  const grid = el('div', 'anki-grid');
  grid.appendChild(tile(String(reviewsToday), 'Reviews today'));
  grid.appendChild(retentionTile(col, 'reviewPass', 'reviewTotal', from30, 'Retention'));
  grid.appendChild(retentionTile(col, 'maturePass', 'matureTotal', from30, 'Mature retention'));
  grid.appendChild(tile(String(streak), 'Day streak'));
  grid.appendChild(tile(String(reviews7), 'Reviews 7d'));
  grid.appendChild(tile(totalTime, 'Total time'));
  body.appendChild(grid);

  body.appendChild(buildSparkline(col, today));
  body.appendChild(buildTypeSplit(col, from30));

  const newCards7 = sumField(col, 'newCards', from7);
  const nc = el('div', 'anki-subline');
  nc.textContent = `New cards 7d: ${newCards7}`;
  body.appendChild(nc);

  const syncLine = buildSyncLine(col);
  if (syncLine) body.appendChild(syncLine);
}
