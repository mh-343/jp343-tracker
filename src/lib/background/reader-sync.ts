import type { ReaderState, ReaderVolumeSnapshot, PendingEntry } from '../../types';
import { DEFAULT_READER_STATE } from '../../types';
import type { BackgroundMessageContext } from './message-context';
import type { ReaderSource } from '../reader-sources';
import { generateProjectId } from '../time-tracker';
import { getLocalDateString } from '../format-utils';
import { withStorageLock } from '../storage-lock';

const WALLCLOCK_SLACK_MIN = 1;
const DAILY_CAP_MIN = 720;
const DAY_RETENTION = 8;

const DEBUG = import.meta.env.DEV;
const log = DEBUG ? console.log.bind(console) : (..._args: unknown[]) => {};

async function loadReaderState(source: ReaderSource): Promise<ReaderState> {
  const result = await browser.storage.local.get(source.stateKey);
  const stored = result[source.stateKey] as ReaderState | undefined;
  if (!stored) return { ...DEFAULT_READER_STATE, baselines: {}, creditedByDay: {} };
  return { ...DEFAULT_READER_STATE, ...stored };
}

async function saveReaderState(source: ReaderSource, state: ReaderState): Promise<void> {
  await browser.storage.local.set({ [source.stateKey]: state });
}

export async function getReaderState(source: ReaderSource): Promise<ReaderState> {
  return loadReaderState(source);
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

    let creditedTotal = 0;

    for (const id of Object.keys(volumes)) {
      const vol = volumes[id];
      if (vol.deleted || !id) continue;

      const baseline = state.baselines[id];
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
          readingCurrentPage: vol.currentPage,
          readingCompleted: vol.completed
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
  if (entries.length > 0) log('[JP343][reader]', source.id, 'booked', entries.length, 'entries');
}
