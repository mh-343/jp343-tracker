import type { ReaderState, ReaderVolumeSnapshot, PendingEntry, JP343UserState } from '../../types';
import { DEFAULT_READER_STATE, SENSOR_VERSION } from '../../types';
import type { BackgroundMessageContext } from './message-context';
import type { ReaderSource } from '../reader-sources';
import { READER_SOURCE_LIST } from '../reader-sources';
import { loadUserState } from '../server-cache';
import { stableUserId } from '../auth-helpers';
import { generateProjectId } from '../time-tracker';
import { getLocalDateString } from '../format-utils';
import { withStorageLock } from '../storage-lock';
import { isValidCharPosition } from '../entry-payload';
import { adoptTtuIds, rekeyPendingTtu } from './ttu-identity';

const WALLCLOCK_SLACK_MIN = 1;
const DAILY_CAP_MIN = 720;
const DAY_RETENTION = 8;

const DEBUG = import.meta.env.DEV;
const log = DEBUG ? console.log.bind(console) : (..._args: unknown[]) => {};

async function loadReaderState(source: ReaderSource): Promise<ReaderState> {
  const result = await browser.storage.local.get(source.stateKey);
  const stored = result[source.stateKey] as ReaderState | undefined;
  if (!stored) return { ...DEFAULT_READER_STATE, baselines: {}, creditedByDay: {}, completedVolumes: {}, pendingCompletionPushes: [] };
  return {
    ...DEFAULT_READER_STATE,
    ...stored,
    completedVolumes: { ...(stored.completedVolumes ?? {}) },
    pendingCompletionPushes: [...(stored.pendingCompletionPushes ?? [])],
    completionBackfill: stored.completionBackfill
      ? { ...stored.completionBackfill, pending: [...stored.completionBackfill.pending] }
      : null
  };
}

async function saveReaderState(source: ReaderSource, state: ReaderState): Promise<void> {
  await browser.storage.local.set({ [source.stateKey]: state });
}

export async function getReaderState(source: ReaderSource): Promise<ReaderState> {
  return loadReaderState(source);
}

// errors come as HTTP 200 with success false
type CompletionResult = 'done' | 'drop' | 'retry' | 'stop';
// rate limit or login: later pushes would fail too
const STOP_CODES = ['E200', 'E001', 'invalid_token'];
// stay below the server limit of 60 per minute
const BURST_MAX = 50;
const BURST_QUIET_MS = 65000;
let burstCount = 0;
let lastPushAt = 0;

function takePushSlot(): boolean {
  const now = Date.now();
  if (now - lastPushAt >= BURST_QUIET_MS || now < lastPushAt) burstCount = 0;
  if (burstCount >= BURST_MAX) return false;
  burstCount++;
  lastPushAt = now;
  return true;
}

async function pushReadingCompletion(userState: JP343UserState | null, projectId: string): Promise<CompletionResult> {
  if (!userState?.isLoggedIn || !userState.extApiToken) return 'stop';
  if (!takePushSlot()) return 'stop';
  const ajaxUrl = userState.ajaxUrl || 'https://jp343.com/wp-admin/admin-ajax.php';
  const body = new URLSearchParams({
    action: 'jp343_extension_reading_mark_completed',
    ext_api_token: userState.extApiToken,
    project_id: projectId,
    completed: '1'
  });
  try {
    const r = await fetch(ajaxUrl, { method: 'POST', credentials: 'include', body, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return 'stop';
    const reply = await r.json().catch(() => null) as { success?: boolean; data?: { code?: string } } | null;
    if (reply?.success === true) return 'done';
    const code = reply?.data?.code;
    if (code === 'E400') return 'drop';
    return !code || STOP_CODES.includes(code) ? 'stop' : 'retry';
  } catch {
    return 'stop';
  }
}

// older versions saw some volumes done but never sent them
async function startCompletionBackfill(source: ReaderSource, userId: number): Promise<void> {
  await withStorageLock(async () => {
    const state = await loadReaderState(source);
    if (state.ownerId !== null && state.ownerId !== userId) return;
    if (state.completionBackfillDone?.includes(userId) || state.completionBackfill?.userId === userId) return;
    const pending = Object.keys(state.completedVolumes)
      .filter(id => state.completedVolumes[id])
      .map(id => generateProjectId(source.platform, '', id));
    state.ownerId = userId;
    state.pendingCompletionPushes = [...new Set([...state.pendingCompletionPushes, ...pending])];
    state.completionBackfill = pending.length ? { userId, pending } : null;
    if (!pending.length) state.completionBackfillDone = [...(state.completionBackfillDone ?? []), userId];
    await saveReaderState(source, state);
  });
}

async function settleCompletionPush(source: ReaderSource, pid: string, userId: number | null): Promise<void> {
  await withStorageLock(async () => {
    const state = await loadReaderState(source);
    state.pendingCompletionPushes = state.pendingCompletionPushes.filter(p => p !== pid);
    const backfill = state.completionBackfill;
    if (backfill && backfill.userId === userId) {
      backfill.pending = backfill.pending.filter(p => p !== pid);
      if (!backfill.pending.length) {
        state.completionBackfillDone = [...new Set([...(state.completionBackfillDone ?? []), backfill.userId])];
        state.completionBackfill = null;
      }
    }
    await saveReaderState(source, state);
  });
}

async function drainAll(): Promise<void> {
  const userState = await loadUserState();
  const userId = stableUserId(userState);
  for (const source of READER_SOURCE_LIST) {
    if (userId !== null && userState?.isLoggedIn && userState.extApiToken) await startCompletionBackfill(source, userId);
    const state = await loadReaderState(source);
    const old = new Set(state.completionBackfill?.pending ?? []);
    // fresh completions go before the re-send
    const queue = [
      ...state.pendingCompletionPushes.filter(pid => !old.has(pid)),
      ...state.pendingCompletionPushes.filter(pid => old.has(pid))
    ];
    for (const pid of queue) {
      const result = await pushReadingCompletion(userState, pid);
      if (result === 'stop') return;
      if (result !== 'retry') await settleCompletionPush(source, pid, userId);
    }
  }
}

let draining: Promise<void> | null = null;

// retry unconfirmed pushes; one drain at a time
export function drainCompletionPushes(): Promise<void> {
  draining ??= drainAll().finally(() => { draining = null; });
  return draining;
}

// project id -> old project id, until the server took it
export async function readerTakeovers(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const source of READER_SOURCE_LIST) {
    const state = await loadReaderState(source);
    for (const [id, legacy] of Object.entries(state.takeovers ?? {})) {
      out.set(generateProjectId(source.platform, '', id), generateProjectId(source.platform, '', legacy));
    }
  }
  return out;
}

export async function confirmReaderTakeovers(projectIds: string[]): Promise<void> {
  await withStorageLock(async () => {
    for (const source of READER_SOURCE_LIST) {
      const state = await loadReaderState(source);
      const prefix = `ext_${source.platform}_`;
      const taken = projectIds.filter(pid => pid.startsWith(prefix) && state.takeovers?.[pid.slice(prefix.length)]);
      if (!taken.length || !state.takeovers) continue;
      for (const pid of taken) delete state.takeovers[pid.slice(prefix.length)];
      await saveReaderState(source, state);
    }
  });
}

// clear tracking when a different account takes over
export async function adoptReaderOwner(userId: number): Promise<void> {
  for (const source of READER_SOURCE_LIST) {
    await withStorageLock(async () => {
      const state = await loadReaderState(source);
      if (state.ownerId != null && state.ownerId !== userId) {
        state.baselines = {};
        state.completedVolumes = {};
        state.pendingCompletionPushes = [];
        state.contentIds = {};
        state.takeovers = {};
        state.completionBackfill = null;
      }
      state.ownerId = userId;
      await saveReaderState(source, state);
    });
  }
}

const mv2Handles = new Map<string, { unregister: () => void }>();

async function registerReaderScript(source: ReaderSource): Promise<void> {
  try {
    const granted = await browser.permissions.contains({ origins: source.origins });
    if (!granted) return;
    if (import.meta.env.MANIFEST_VERSION === 3) {
      const existing = await browser.scripting.getRegisteredContentScripts({ ids: [source.scriptId] });
      if (existing.length > 0) return;
      await browser.scripting.registerContentScripts([{
        id: source.scriptId,
        matches: source.origins,
        js: [source.scriptFile],
        runAt: 'document_idle',
        persistAcrossSessions: true
      }]);
    } else if (!mv2Handles.has(source.id)) {
      const handle = await browser.contentScripts.register({
        matches: source.origins,
        js: [{ file: source.scriptFile }],
        runAt: 'document_idle'
      });
      mv2Handles.set(source.id, handle);
    }
  } catch (error) {
    log('[JP343][reader]', source.id, 'register failed', error);
  }
}

async function unregisterReaderScript(source: ReaderSource): Promise<void> {
  try {
    if (import.meta.env.MANIFEST_VERSION === 3) {
      const existing = await browser.scripting.getRegisteredContentScripts({ ids: [source.scriptId] });
      if (existing.length > 0) await browser.scripting.unregisterContentScripts({ ids: [source.scriptId] });
    } else {
      const handle = mv2Handles.get(source.id);
      if (handle) {
        handle.unregister();
        mv2Handles.delete(source.id);
      }
    }
  } catch (error) {
    log('[JP343][reader]', source.id, 'unregister failed', error);
  }
}

export async function syncReaderRegistration(source: ReaderSource): Promise<void> {
  const state = await loadReaderState(source);
  if (state.enabled) await registerReaderScript(source);
  else await unregisterReaderScript(source);
}

// Reinject target if enabled + permitted
export async function getReaderReinjectTarget(source: ReaderSource): Promise<{ matches: string[]; file: string } | null> {
  const state = await loadReaderState(source);
  if (!state.enabled) return null;
  try {
    if (!(await browser.permissions.contains({ origins: source.origins }))) return null;
  } catch {
    return null;
  }
  return { matches: source.origins, file: source.scriptFile };
}

export async function setReaderEnabled(source: ReaderSource, enabled: boolean): Promise<ReaderState> {
  await withStorageLock(async () => {
    const state = await loadReaderState(source);
    // re-baseline on enable, no back-credit
    if (enabled && !state.enabled) state.baselines = {};
    state.enabled = enabled;
    await saveReaderState(source, state);
  });
  if (enabled) await registerReaderScript(source);
  else await unregisterReaderScript(source);
  return loadReaderState(source);
}

function volumeName(source: ReaderSource, vol: ReaderVolumeSnapshot, id: string): string {
  if (vol.seriesTitle && vol.volumeTitle) return `${vol.seriesTitle} / ${vol.volumeTitle}`;
  return vol.volumeTitle || vol.seriesTitle || `${source.label} ${id.slice(0, 8)}`;
}

function readingFields(source: ReaderSource, vol: ReaderVolumeSnapshot): Partial<PendingEntry> {
  if (source.platform === 'ttu') {
    return isValidCharPosition(vol.readingOffset, vol.readingTotal)
      ? { readingUnit: 'char', readingOffset: vol.readingOffset, readingTotal: vol.readingTotal }
      : {};
  }
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
  const seriesUuid = text(vol.seriesUuid);
  const seriesTitle = text(vol.seriesTitle);
  const volumeTitle = text(vol.volumeTitle);
  return {
    readingCurrentPage: vol.currentPage,
    ...(seriesUuid ? { seriesUuid } : {}),
    ...(seriesTitle ? { seriesTitle } : {}),
    ...(volumeTitle ? { volumeTitle } : {})
  };
}

function pruneDays(creditedByDay: Record<string, number>): Record<string, number> {
  const days = Object.keys(creditedByDay).sort();
  if (days.length <= DAY_RETENTION) return creditedByDay;
  const keep = new Set(days.slice(days.length - DAY_RETENTION));
  const out: Record<string, number> = {};
  for (const d of days) if (keep.has(d)) out[d] = creditedByDay[d];
  return out;
}

export async function ingestReaderSnapshot(
  source: ReaderSource,
  volumes: Record<string, ReaderVolumeSnapshot>,
  ctx: BackgroundMessageContext
): Promise<void> {
  const settings = await ctx.loadSettings();
  const dayStartHour = settings.dayStartHour || 0;
  const now = Date.now();
  const today = getLocalDateString(new Date(now), dayStartHour);

  const entries: PendingEntry[] = [];

  await withStorageLock(async () => {
    const state = await loadReaderState(source);
    if (!state.enabled) return;

    let snapshot = volumes;
    if (source.platform === 'ttu') {
      const adopted = adoptTtuIds(state, volumes);
      await rekeyPendingTtu(adopted.moves);
      snapshot = adopted.volumes;
    }

    let creditedTotal = 0;

    for (const id of Object.keys(snapshot)) {
      const vol = snapshot[id];
      if (vol.deleted || !id) continue;

      const baseline = state.baselines[id];
      // first sight counts too; no duration needed
      if (vol.completed && !state.completedVolumes[id]) {
        state.completedVolumes[id] = true;
        const pid = generateProjectId(source.platform, '', id);
        if (!state.pendingCompletionPushes.includes(pid)) state.pendingCompletionPushes.push(pid);
      }
      // First sight or reset: rebase only
      if (!baseline || vol.effectiveMin < baseline.lastEffectiveMin || vol.chars < baseline.lastChars) {
        state.baselines[id] = { lastEffectiveMin: vol.effectiveMin, lastChars: vol.chars, lastObservedAt: now };
        continue;
      }

      const minutesDelta = vol.effectiveMin - baseline.lastEffectiveMin;
      const charsDelta = vol.chars - baseline.lastChars;

      const elapsedMin = Math.floor((now - baseline.lastObservedAt) / 60000) + WALLCLOCK_SLACK_MIN;
      const usedToday = state.creditedByDay[today] || 0;
      const credit = Math.min(minutesDelta, Math.max(0, elapsedMin), Math.max(0, DAILY_CAP_MIN - usedToday));

      if (credit > 0 || charsDelta > 0) {
        if (credit > 0) {
          state.creditedByDay[today] = usedToday + credit;
          creditedTotal += credit;
          state.totalChars = (state.totalChars ?? 0) + charsDelta;
        }
        const name = volumeName(source, vol, id);
        entries.push({
          id: `${source.id}-${id}-${now}`,
          date: new Date(now).toISOString(),
          duration_min: credit,
          project: name,
          project_id: generateProjectId(source.platform, name, id),
          platform: source.platform,
          source: 'extension',
          url: source.entryUrl,
          thumbnail: null,
          synced: false,
          syncedAt: null,
          syncAttempts: 0,
          lastSyncError: null,
          serverEntryId: null,
          channelId: null,
          channelName: null,
          channelUrl: null,
          activityType: 'reading',
          chars: charsDelta,
          ...readingFields(source, vol),
          readingCompleted: vol.completed,
          trackingMode: settings.trackJapaneseOnly ? 'jp_only' : 'all',
          sensorVersion: SENSOR_VERSION
        });
      }

      state.baselines[id] = { lastEffectiveMin: vol.effectiveMin, lastChars: vol.chars, lastObservedAt: now };
    }

    state.creditedByDay = pruneDays(state.creditedByDay);
    state.lastSyncAt = now;
    state.totalMinutes += creditedTotal;
    await saveReaderState(source, state);
  });

  for (const entry of entries) {
    await ctx.savePendingEntry(entry);
  }
  void drainCompletionPushes();
  if (entries.length > 0) log('[JP343][reader]', source.id, 'booked', entries.length, 'entries');
}
