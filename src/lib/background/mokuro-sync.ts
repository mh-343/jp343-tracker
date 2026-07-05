import type { MokuroState, MokuroVolumeSnapshot, PendingEntry } from '../../types';
import { STORAGE_KEYS, DEFAULT_MOKURO_STATE } from '../../types';
import type { BackgroundMessageContext } from './message-context';
import { generateProjectId } from '../time-tracker';
import { getLocalDateString } from '../format-utils';
import { withStorageLock } from '../storage-lock';

const WALLCLOCK_SLACK_MIN = 1;
const DAILY_CAP_MIN = 720;
const DAY_RETENTION = 8;
const MOKURO_URL = 'https://reader.mokuro.app/';
export const MOKURO_ORIGIN = '*://reader.mokuro.app/*';
const MOKURO_SCRIPT_ID = 'mokuro-reader';
export const MOKURO_SCRIPT_JS = 'content-scripts/mokuro.js';

const DEBUG = import.meta.env.DEV;
const log = DEBUG ? console.log.bind(console) : (..._args: unknown[]) => {};

async function loadMokuroState(): Promise<MokuroState> {
  const result = await browser.storage.local.get(STORAGE_KEYS.MOKURO);
  const stored = result[STORAGE_KEYS.MOKURO] as MokuroState | undefined;
  if (!stored) return { ...DEFAULT_MOKURO_STATE, baselines: {}, creditedByDay: {} };
  return { ...DEFAULT_MOKURO_STATE, ...stored };
}

async function saveMokuroState(state: MokuroState): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.MOKURO]: state });
}

export async function getMokuroState(): Promise<MokuroState> {
  return loadMokuroState();
}

let mv2Handle: { unregister: () => void } | null = null;

async function registerMokuroScript(): Promise<void> {
  try {
    const granted = await browser.permissions.contains({ origins: [MOKURO_ORIGIN] });
    if (!granted) return;
    if (import.meta.env.MANIFEST_VERSION === 3) {
      const existing = await browser.scripting.getRegisteredContentScripts({ ids: [MOKURO_SCRIPT_ID] });
      if (existing.length > 0) return;
      await browser.scripting.registerContentScripts([{
        id: MOKURO_SCRIPT_ID,
        matches: [MOKURO_ORIGIN],
        js: [MOKURO_SCRIPT_JS],
        runAt: 'document_idle',
        persistAcrossSessions: true
      }]);
    } else if (!mv2Handle) {
      mv2Handle = await browser.contentScripts.register({
        matches: [MOKURO_ORIGIN],
        js: [{ file: MOKURO_SCRIPT_JS }],
        runAt: 'document_idle'
      });
    }
  } catch (error) {
    log('[JP343][mokuro] register failed', error);
  }
}

async function unregisterMokuroScript(): Promise<void> {
  try {
    if (import.meta.env.MANIFEST_VERSION === 3) {
      const existing = await browser.scripting.getRegisteredContentScripts({ ids: [MOKURO_SCRIPT_ID] });
      if (existing.length > 0) await browser.scripting.unregisterContentScripts({ ids: [MOKURO_SCRIPT_ID] });
    } else if (mv2Handle) {
      mv2Handle.unregister();
      mv2Handle = null;
    }
  } catch (error) {
    log('[JP343][mokuro] unregister failed', error);
  }
}

export async function syncMokuroRegistration(): Promise<void> {
  const state = await loadMokuroState();
  if (state.enabled) await registerMokuroScript();
  else await unregisterMokuroScript();
}

// Reinject target if enabled + permitted
export async function getMokuroReinjectTarget(): Promise<{ matches: string[]; file: string } | null> {
  const state = await loadMokuroState();
  if (!state.enabled) return null;
  try {
    if (!(await browser.permissions.contains({ origins: [MOKURO_ORIGIN] }))) return null;
  } catch {
    return null;
  }
  return { matches: [MOKURO_ORIGIN], file: MOKURO_SCRIPT_JS };
}

export async function setMokuroEnabled(enabled: boolean): Promise<MokuroState> {
  await withStorageLock(async () => {
    const state = await loadMokuroState();
    // re-baseline on enable, no back-credit
    if (enabled && !state.enabled) state.baselines = {};
    state.enabled = enabled;
    await saveMokuroState(state);
  });
  if (enabled) await registerMokuroScript();
  else await unregisterMokuroScript();
  return loadMokuroState();
}

function volumeName(vol: MokuroVolumeSnapshot, id: string): string {
  if (vol.seriesTitle && vol.volumeTitle) return `${vol.seriesTitle} / ${vol.volumeTitle}`;
  return vol.volumeTitle || vol.seriesTitle || `Mokuro ${id.slice(0, 8)}`;
}

function pruneDays(creditedByDay: Record<string, number>): Record<string, number> {
  const days = Object.keys(creditedByDay).sort();
  if (days.length <= DAY_RETENTION) return creditedByDay;
  const keep = new Set(days.slice(days.length - DAY_RETENTION));
  const out: Record<string, number> = {};
  for (const d of days) if (keep.has(d)) out[d] = creditedByDay[d];
  return out;
}

export async function ingestMokuroSnapshot(
  volumes: Record<string, MokuroVolumeSnapshot>,
  ctx: BackgroundMessageContext
): Promise<void> {
  const settings = await ctx.loadSettings();
  const dayStartHour = settings.dayStartHour || 0;
  const now = Date.now();
  const today = getLocalDateString(new Date(now), dayStartHour);

  const entries: PendingEntry[] = [];

  await withStorageLock(async () => {
    const state = await loadMokuroState();
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
        const name = volumeName(vol, id);
        entries.push({
          id: `mokuro-${id}-${now}`,
          date: new Date(now).toISOString(),
          duration_min: credit,
          project: name,
          project_id: generateProjectId('mokuro', name, id),
          platform: 'mokuro',
          source: 'extension',
          url: MOKURO_URL,
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
          chars: charsDelta
        });
      }

      state.baselines[id] = { lastEffectiveMin: vol.effectiveMin, lastChars: vol.chars, lastObservedAt: now };
    }

    state.creditedByDay = pruneDays(state.creditedByDay);
    state.lastSyncAt = now;
    state.totalMinutes += creditedTotal;
    await saveMokuroState(state);
  });

  for (const entry of entries) {
    await ctx.savePendingEntry(entry);
  }
  if (entries.length > 0) log('[JP343][mokuro] booked', entries.length, 'reading entries');
}
