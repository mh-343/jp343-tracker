import type { PendingEntry, SavePendingResult } from '../../types';
import { STORAGE_KEYS } from '../../types';
import type { MpchcState } from '../mpchc';
import { emptyMpchcState, MPCHC_ORIGINS } from '../mpchc';
import { withStorageLock } from '../storage-lock';
import { readMpchc } from './mpchc-connect';
import { advanceMpchcSession, mpchcEntry, startMpchcSession, MPCHC_PERIOD_MINUTES } from './mpchc-session';

export const MPCHC_ALARM = 'jp343-mpchc-probe';
const BACKOFF_FAILURES = 8;

interface MpchcDeps {
  savePendingEntry: (entry: PendingEntry) => Promise<SavePendingResult>;
  createAlarmSafe: (name: string, options: { periodInMinutes: number }) => void;
}

let deps: MpchcDeps;
let operations: Promise<unknown> = Promise.resolve();
let pollInFlight: Promise<void> | null = null;

function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = operations.then(operation);
  operations = result.catch(() => {});
  return result;
}

export async function getMpchcState(): Promise<MpchcState> {
  const stored = (await browser.storage.local.get(STORAGE_KEYS.MPCHC))[STORAGE_KEYS.MPCHC] as Partial<MpchcState> | undefined;
  return { ...emptyMpchcState(), ...stored };
}

async function persist(state: MpchcState): Promise<void> {
  await withStorageLock(() => browser.storage.local.set({ [STORAGE_KEYS.MPCHC]: state }));
}

async function gate(state: MpchcState): Promise<boolean> {
  if (!state.enabled) { state.status = 'off'; return false; }
  if ((await browser.runtime.getPlatformInfo()).os === 'android') {
    state.status = 'unsupported';
    return false;
  }
  if (!(await browser.permissions.contains({ origins: MPCHC_ORIGINS }))) {
    state.status = 'permission_needed';
    return false;
  }
  return true;
}

function activePeriod(): number {
  return import.meta.env.FIREFOX ? 1 : MPCHC_PERIOD_MINUTES;
}

async function arm(state: MpchcState, allowed: boolean): Promise<void> {
  if (!allowed) { await browser.alarms.clear(MPCHC_ALARM); return; }
  const periodInMinutes = state.failures >= BACKOFF_FAILURES && !state.session ? 5 : activePeriod();
  const alarm = await browser.alarms.get(MPCHC_ALARM);
  if (alarm?.periodInMinutes !== periodInMinutes) deps.createAlarmSafe(MPCHC_ALARM, { periodInMinutes });
}

async function drain(state: MpchcState): Promise<void> {
  if (!state.outbox) return;
  const result = await deps.savePendingEntry(state.outbox);
  if (result === 'error') throw new Error('Could not save player session');
  state.outbox = null;
  await persist(state);
}

async function finalize(state: MpchcState): Promise<void> {
  if (!state.session) return;
  state.outbox = await mpchcEntry(state.session);
  state.session = null;
  await persist(state);
  await drain(state);
}

async function poll(): Promise<void> {
  const state = await getMpchcState();
  const allowed = await gate(state);
  await arm(state, allowed);
  await drain(state);
  if (!allowed) {
    await finalize(state);
    await persist(state);
    return;
  }
  const { snapshot, status } = await readMpchc();
  const now = Date.now();
  state.failures = snapshot ? 0 : Math.min(BACKOFF_FAILURES, state.failures + 1);
  state.status = snapshot ? (snapshot.state === 2 ? 'playing' : snapshot.state === 1 ? 'paused' : 'idle') : status;
  if (state.session && snapshot?.file && snapshot.file !== state.session.file) await finalize(state);
  if (state.session) {
    if (advanceMpchcSession(state.session, snapshot, now, activePeriod())) await finalize(state);
  } else if (snapshot?.state === 2 && snapshot.file) {
    state.session = startMpchcSession(snapshot, now);
  }
  await persist(state);
  await arm(state, true);
}

export function pollMpchc(): Promise<void> {
  if (!pollInFlight) {
    pollInFlight = exclusive(poll).finally(() => { pollInFlight = null; });
  }
  return pollInFlight;
}

export async function setMpchcEnabled(enabled: boolean): Promise<MpchcState> {
  await exclusive(async () => {
    const state = await getMpchcState();
    state.enabled = enabled;
    state.failures = 0;
    const allowed = await gate(state);
    await persist(state);
    await arm(state, allowed);
    await drain(state);
    if (!allowed) await finalize(state);
  });
  if (enabled) await pollMpchc();
  return getMpchcState();
}

export function initMpchcPoller(callbacks: MpchcDeps): void {
  deps = callbacks;
  browser.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === MPCHC_ALARM) void pollMpchc().catch(() => {});
  });
  browser.permissions.onRemoved.addListener(() => { void pollMpchc().catch(() => {}); });
  browser.permissions.onAdded.addListener(() => { void pollMpchc().catch(() => {}); });
  void pollMpchc().catch(() => {});
}
