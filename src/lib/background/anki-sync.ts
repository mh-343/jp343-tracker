import type { AnkiState, AnkiCollectionState, AnkiDay, AnkiStatus, ExtensionSettings, JP343UserState } from '../../types';
import { STORAGE_KEYS, DEFAULT_ANKI_STATE, DEFAULT_SETTINGS, ANKI_SCHEMA_VERSION } from '../../types';
import { getLocalDateString } from '../format-utils';
import { withStorageLock } from '../storage-lock';
import { ensureConnected, getActiveProfile, getDeckNames, pullReviews, maturitySnapshot } from './anki-connect';
import type { Revlog } from './anki-connect';

const WINDOW_DAYS = 14;
const MAX_DAY_SECONDS = 86400;
const DEBUG = import.meta.env.DEV;
const log = DEBUG ? console.log.bind(console) : (..._args: unknown[]) => {};

let ankiSyncInProgress = false;
let ankiSyncQueued = false;

function emptyDay(): AnkiDay {
  return { seconds: 0, reviews: 0, newCards: 0, reviewPass: 0, reviewTotal: 0, maturePass: 0, matureTotal: 0, learn: 0, review: 0, relearn: 0, cram: 0 };
}

function freshCollection(): AnkiCollectionState {
  return { lastSyncId: 0, backfillDone: false, days: {}, seenCardIds: [], dirtyDays: [], lastPushedAt: null, lastPushError: null };
}

async function loadAnkiState(): Promise<AnkiState> {
  const result = await browser.storage.local.get(STORAGE_KEYS.ANKI);
  const stored = result[STORAGE_KEYS.ANKI] as AnkiState | undefined;
  if (!stored) return { ...DEFAULT_ANKI_STATE, collections: {} };
  return { ...DEFAULT_ANKI_STATE, ...stored };   // backfill new fields for old installs
}

// selected decks + their subdecks; empty = all
function filterDecks(all: string[], selected: string[]): string[] {
  if (!selected || selected.length === 0) return all;
  return all.filter(d => selected.some(s => d === s || d.startsWith(s + '::')));
}

async function saveAnkiState(state: AnkiState): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.ANKI]: state });
}

async function loadDayStartHour(): Promise<number> {
  const result = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEYS.SETTINGS] as Partial<ExtensionSettings> | undefined) };
  return settings.dayStartHour || 0;
}

let androidCache: boolean | null = null;
async function isAndroid(): Promise<boolean> {
  if (androidCache !== null) return androidCache;
  try {
    const info = await browser.runtime.getPlatformInfo();
    androidCache = info.os === 'android';
  } catch {
    androidCache = false;
  }
  return androidCache;
}

export async function getAnkiState(): Promise<AnkiState> {
  return loadAnkiState();
}

export async function setAnkiEnabled(enabled: boolean): Promise<AnkiState> {
  await withStorageLock(async () => {
    const state = await loadAnkiState();
    state.enabled = enabled;
    state.schemaVersion = ANKI_SCHEMA_VERSION;
    if (!enabled) state.status = 'idle';
    await saveAnkiState(state);
  });
  if (enabled) await syncAnki();
  return loadAnkiState();
}

export async function getAnkiDecks(): Promise<{ decks: string[]; selected: string[]; reachable: boolean }> {
  const state = await loadAnkiState();
  try {
    const decks = await getDeckNames();
    decks.sort();
    return { decks, selected: state.selectedDecks, reachable: true };
  } catch {
    return { decks: [], selected: state.selectedDecks, reachable: false };
  }
}

// Scope change: re-scope locally AND on the server (flag), then rebuild from revlog.
export async function setAnkiDecks(decks: string[]): Promise<AnkiState> {
  await withStorageLock(async () => {
    const state = await loadAnkiState();
    state.selectedDecks = decks;        // set first: in-flight old-scope syncs abort
    state.pendingServerReset = true;    // server cleared before the next push
    for (const key of Object.keys(state.collections)) {
      const c = state.collections[key];
      c.days = {};
      c.seenCardIds = [];
      c.dirtyDays = [];
      c.backfillDone = false;
      c.lastSyncId = 0;
      c.lastPushError = null;
    }
    await saveAnkiState(state);
  });
  await syncAnki();
  return loadAnkiState();
}

async function patchStatus(status: AnkiStatus): Promise<void> {
  await withStorageLock(async () => {
    const state = await loadAnkiState();
    state.status = status;
    await saveAnkiState(state);
  });
}

function aggregate(reviews: Revlog[], seen: Set<number>, dayStartHour: number): Record<string, AnkiDay> {
  const perDay: Record<string, AnkiDay> = {};
  for (const r of reviews) {
    const type = r[8];
    if (type !== 0 && type !== 1 && type !== 2 && type !== 3) continue;   // fail-closed
    const ms = Number(r[7]);
    const day = getLocalDateString(new Date(r[0]), dayStartHour);
    const d = perDay[day] ?? (perDay[day] = emptyDay());
    d.seconds += Number.isFinite(ms) ? ms / 1000 : 0;
    d.reviews += 1;
    const ease = Number(r[3]);
    const lastIvl = Number(r[5]);
    if (type === 0) {
      d.learn += 1;
    } else if (type === 1) {
      d.review += 1;
      d.reviewTotal += 1;
      if (ease > 1) d.reviewPass += 1;
      if (lastIvl >= 21) {
        d.matureTotal += 1;
        if (ease > 1) d.maturePass += 1;
      }
    } else if (type === 2) {
      d.relearn += 1;
    } else if (type === 3) {
      d.cram += 1;                                  // no retention
    }
    if (!seen.has(r[1])) {                          // first-ever sighting
      seen.add(r[1]);
      d.newCards += 1;
    }
  }
  for (const day of Object.keys(perDay)) {
    perDay[day].seconds = Math.min(Math.round(perDay[day].seconds), MAX_DAY_SECONDS);
  }
  return perDay;
}

// camelCase -> server snake_case
function toWireDay(date: string, d: AnkiDay): Record<string, string | number> {
  const wire: Record<string, string | number> = {
    date,
    seconds: d.seconds, reviews: d.reviews, new_cards: d.newCards,
    review_pass: d.reviewPass, review_total: d.reviewTotal,
    mature_pass: d.maturePass, mature_total: d.matureTotal,
    learn: d.learn, relearn: d.relearn, cram: d.cram
  };
  // atomic all-3-or-none; absence = no snapshot (server stores NULL, not 0)
  if (typeof d.colMature === 'number' && typeof d.colYoung === 'number' && typeof d.colNew === 'number') {
    wire.col_mature = d.colMature;
    wire.col_young = d.colYoung;
    wire.col_new = d.colNew;
  }
  return wire;
}

const PUSH_CHUNK = 400;

type PushOutcome =
  | { kind: 'ok' }
  | { kind: 'partial'; failedDates: string[] }
  | { kind: 'fail'; error: string };

interface AnkiSyncResponse {
  success?: boolean;
  data?: { failed?: number; failed_dates?: unknown; message?: unknown };
}

async function pushChunk(ajaxUrl: string, token: string, days: Record<string, string | number>[]): Promise<PushOutcome> {
  const params = new URLSearchParams({
    action: 'jp343_extension_sync_anki_time',
    ext_api_token: token,
    ext_version: browser.runtime.getManifest().version,
    schema_version: String(ANKI_SCHEMA_VERSION),
    days: JSON.stringify(days)
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let text: string;
  try {
    const response = await fetch(ajaxUrl, { method: 'POST', credentials: 'include', signal: controller.signal, body: params });
    if (!response.ok) return { kind: 'fail', error: `HTTP ${response.status}` };
    text = await response.text();
  } catch {
    return { kind: 'fail', error: 'Network error' };
  } finally {
    clearTimeout(timeout);
  }
  if (text === '0') return { kind: 'fail', error: 'server_not_ready' };   // unknown action
  let result: AnkiSyncResponse;
  try { result = JSON.parse(text) as AnkiSyncResponse; } catch { return { kind: 'fail', error: 'Bad response' }; }

  const data = result.data ?? {};
  const message = typeof data.message === 'string' ? data.message : '';
  if (message.toLowerCase().includes('schema')) return { kind: 'fail', error: 'server_not_ready' };

  const failed = typeof data.failed === 'number' ? data.failed : 0;
  if (result.success && failed === 0) return { kind: 'ok' };

  const failedDates = Array.isArray(data.failed_dates)
    ? data.failed_dates.filter((d): d is string => typeof d === 'string')
    : null;
  if (failedDates && failed > 0) return { kind: 'partial', failedDates };
  return { kind: 'fail', error: message || 'Sync failed' };   // no list: keep all dirty
}

async function clearDays(profile: string, dates: string[], err: string | null): Promise<void> {
  await withStorageLock(async () => {
    const fresh = await loadAnkiState();
    const c = fresh.collections[profile];
    if (!c) return;
    if (dates.length > 0) {
      const clear = new Set(dates);
      c.dirtyDays = c.dirtyDays.filter(day => !clear.has(day));
      c.lastPushedAt = Date.now();
    }
    c.lastPushError = err;
    await saveAnkiState(fresh);
  });
}

// push dirty days in <=400-day chunks; guests stay local
async function pushAnki(): Promise<void> {
  const state = await loadAnkiState();
  const profile = state.activeCollection;
  if (!profile) return;
  const col = state.collections[profile];
  if (!col || col.dirtyDays.length === 0) return;

  const userResult = await browser.storage.local.get(STORAGE_KEYS.USER);
  const user = userResult[STORAGE_KEYS.USER] as JP343UserState | undefined;
  if (!user?.isLoggedIn || !user.extApiToken) return;

  const ajaxUrl = user.ajaxUrl || 'https://jp343.com/wp-admin/admin-ajax.php';
  const allDirty = [...col.dirtyDays];

  for (let i = 0; i < allDirty.length; i += PUSH_CHUNK) {
    const chunkDates = allDirty.slice(i, i + PUSH_CHUNK);
    const days: Record<string, string | number>[] = [];
    for (const date of chunkDates) {
      const d = col.days[date];
      if (d) days.push(toWireDay(date, d));
    }
    if (days.length === 0) continue;

    const outcome = await pushChunk(ajaxUrl, user.extApiToken, days);
    if (outcome.kind === 'ok') {
      await clearDays(profile, chunkDates, null);
    } else if (outcome.kind === 'partial') {
      const failedSet = new Set(outcome.failedDates);
      await clearDays(profile, chunkDates.filter(d => !failedSet.has(d)), 'Some days failed to sync');
      return;   // leave failed + remaining chunks dirty
    } else {
      await clearDays(profile, [], outcome.error);   // clear nothing on hard fail
      return;
    }
  }
}

// logout: flush then drop all push queues
export async function flushAndResetAnki(): Promise<void> {
  try { await pushAnki(); } catch { /* ignore */ }
  await withStorageLock(async () => {
    const state = await loadAnkiState();
    state.pendingServerReset = false;   // do not carry a reset across accounts
    for (const key of Object.keys(state.collections)) {
      state.collections[key].dirtyDays = [];
      state.collections[key].lastPushError = null;
    }
    await saveAnkiState(state);
  });
}

// delete the user's server rows; true = deleted or guest (nothing to do)
async function deleteServerAnki(): Promise<boolean> {
  const userResult = await browser.storage.local.get(STORAGE_KEYS.USER);
  const user = userResult[STORAGE_KEYS.USER] as JP343UserState | undefined;
  if (!user?.isLoggedIn || !user.extApiToken) return true;
  try {
    const ajaxUrl = user.ajaxUrl || 'https://jp343.com/wp-admin/admin-ajax.php';
    const response = await fetch(ajaxUrl, {
      method: 'POST',
      credentials: 'include',
      body: new URLSearchParams({
        action: 'jp343_extension_reset_anki',
        ext_api_token: user.extApiToken,
        ext_version: browser.runtime.getManifest().version
      })
    });
    if (!response.ok) return false;
    const text = await response.text();
    if (text === '0') return false;
    const result = JSON.parse(text) as { success?: boolean };
    return result.success === true;
  } catch {
    return false;
  }
}

// before a scoped push: if a reset is pending, clear the server first
async function ensureServerScopeReset(): Promise<boolean> {
  const state = await loadAnkiState();
  if (!state.pendingServerReset) return true;
  if (!(await deleteServerAnki())) return false;   // retry next sync; do not push yet
  await withStorageLock(async () => {
    const fresh = await loadAnkiState();
    fresh.pendingServerReset = false;
    await saveAnkiState(fresh);
  });
  return true;
}

// delete local + server Anki data; rebuilds from revlog on next sync
export async function resetAnkiData(): Promise<AnkiState> {
  await deleteServerAnki();
  await withStorageLock(async () => {
    const state = await loadAnkiState();
    state.collections = {};        // keep enabled + selectedDecks
    state.activeCollection = null;
    state.lastSyncAt = null;
    state.pendingServerReset = false;
    await saveAnkiState(state);
  });
  return loadAnkiState();
}

export async function syncAnki(): Promise<void> {
  if (ankiSyncInProgress) { ankiSyncQueued = true; return; }   // coalesce: rerun after current
  ankiSyncInProgress = true;                                    // set synchronously (no await gap)
  try {
    if (await isAndroid()) return;
    const initial = await loadAnkiState();
    if (!initial.enabled) return;

    const status = await ensureConnected();
    if (status !== 'connected') {
      await patchStatus(status);
      return;
    }

    const profile = await getActiveProfile();
    if (!profile) { await patchStatus('error'); return; }   // do not guess a bucket
    const scopeKey = JSON.stringify(initial.selectedDecks);  // detect a mid-sync deck change
    const decks = filterDecks(await getDeckNames(), initial.selectedDecks);
    const dayStartHour = await loadDayStartHour();

    const snapshot = await loadAnkiState();
    const known = snapshot.collections[profile];
    // v1: full pull on first sync; chunked backfill is a follow-up
    const startId = known?.backfillDone ? Date.now() - WINDOW_DAYS * 86400000 : 0;
    const reviews = await pullReviews(decks, startId);
    const maturity = await maturitySnapshot(initial.selectedDecks);   // current-state, attached to today

    let aborted = false;
    await withStorageLock(async () => {
      const state = await loadAnkiState();
      if (JSON.stringify(state.selectedDecks) !== scopeKey) { aborted = true; return; }  // scope changed
      const col = state.collections[profile] ?? freshCollection();
      const seen = new Set(col.seenCardIds);
      const perDay = aggregate(reviews, seen, dayStartHour);
      col.seenCardIds = Array.from(seen);
      for (const [day, agg] of Object.entries(perDay)) {
        const prevNew = col.days[day]?.newCards ?? 0;
        col.days[day] = { ...agg, newCards: prevNew + agg.newCards };  // accumulate genuinely-new
        if (!col.dirtyDays.includes(day)) col.dirtyDays.push(day);
      }
      if (maturity) {
        const today = getLocalDateString(new Date(), dayStartHour);
        const day = col.days[today] ?? (col.days[today] = emptyDay());   // today may have 0 reviews
        day.colMature = maturity.mature;
        day.colYoung = maturity.young;
        day.colNew = maturity.new;
        if (!col.dirtyDays.includes(today)) col.dirtyDays.push(today);
      }
      col.backfillDone = true;
      state.collections[profile] = col;
      state.activeCollection = profile;
      state.status = 'connected';
      state.lastSyncAt = Date.now();
      state.schemaVersion = ANKI_SCHEMA_VERSION;
      await saveAnkiState(state);
    });
    if (aborted) return;   // a deck change landed mid-sync; the rerun handles the new scope

    if (await ensureServerScopeReset()) await pushAnki();   // skip push if server reset still pending
    log('[JP343][anki] synced', profile, reviews.length);
  } catch (error) {
    log('[JP343][anki] sync error', error);
    await patchStatus('error');
  } finally {
    ankiSyncInProgress = false;
    if (ankiSyncQueued) { ankiSyncQueued = false; void syncAnki(); }   // run the coalesced request
  }
}
