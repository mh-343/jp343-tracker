import type { ExtensionSettings, JP343UserState } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { stableUserId } from '../auth-helpers';
import type { GsmGame } from '../gsm/api';
import { fetchGsmLines, GsmReadError, openGsm } from '../gsm/api';
import { resolveGsmDbIdentity } from '../gsm/db-identity';
import type { PlannedDay, WireGame } from '../gsm/payload';
import { addDays, dayRange, localDayKey, mapGsmGames, MAX_CALL_GAMES, planGsmDays, splitGsmCalls, utcString } from '../gsm/payload';
import { withoutImportOverlaps } from '../gsm/import';
import { gsmV1Sessions, sha256Hex } from '../gsm/rule';
import type { GsmState, GsmStatus } from '../gsm/state';
import { gsmCandidatePorts, gsmOrigin } from '../gsm/state';
import { captureServerRequestContext, isContextStillCurrent, loadUserState } from '../server-cache';
import type { ServerRequestContext } from '../server-cache';
import { withStorageLock } from '../storage-lock';
import type { AuthRecoveryResult } from './auth-recovery';
import { getGsmState, gsmAccess, patchGsmState, writeGsmEnabled } from './gsm-connect';
import { loadGsmImportStore, settleGsmImportDeferred } from './gsm-import';
import { applyLocalDays, applyLocalServerResult, locallyDeletedIds } from './gsm-local';
import { awaitGsmCallGap, gsmSignedInContext, postGsmSync } from './gsm-sync';

export const GSM_ALARM = 'jp343-gsm-sync';
const BACKOFF_PERIOD_MINUTES = 5;
const BACKOFF_FAILURES = 6;
const SEND_INTERVAL_MS = 5 * 60_000;
const REFRESH_INTERVAL_MS = 30 * 60_000;
const FULL_INTERVAL_MS = 24 * 60 * 60_000;
const FULL_BLOCK_DAYS = 14;
const FULL_MAX_CALLS = 10;

interface GsmDeps {
  createAlarmSafe: (name: string, options: { periodInMinutes: number }) => void;
  recover: (user?: JP343UserState | null) => Promise<AuthRecoveryResult>;
  loadSettings: () => Promise<ExtensionSettings>;
  onServerChanged?: () => void;
}

interface GsmRun {
  enabledAt: number;
  dbId: string;
  games: GsmGame[];
  server: ServerRequestContext | null;
  dayStartHour: number;
  status: GsmStatus;
  skipped: number;
  oversized: number;
  calls: number;
  sent: boolean;
  changed: boolean;
  recovered: boolean;
  lbExcluded: Record<string, number>;
}

interface GsmRead {
  days: PlannedDay[];
  games: WireGame[];
}

// last read of yesterday and today the server has not seen
interface GsmOutbox extends GsmRead {
  fingerprint: string;
  owner: number;
  enabledAt: number;
  dbId: string;
  flushTried: boolean;
}

type RangeStop = 'budget' | 'failed' | null;

let deps: GsmDeps;
let running: Promise<void> | null = null;
let queued = false;
let queuedFull = false;
let queuedForce = false;

export function gsmPeriodMinutes(): number {
  return import.meta.env.FIREFOX ? 1 : 0.5;
}

async function arm(allowed: boolean, failures: number): Promise<void> {
  if (!allowed) { await browser.alarms.clear(GSM_ALARM); return; }
  const periodInMinutes = failures >= BACKOFF_FAILURES ? BACKOFF_PERIOD_MINUTES : gsmPeriodMinutes();
  const alarm = await browser.alarms.get(GSM_ALARM);
  if (alarm?.periodInMinutes !== periodInMinutes) deps.createAlarmSafe(GSM_ALARM, { periodInMinutes });
}

function signedInContext(): Promise<ServerRequestContext | null> {
  return gsmSignedInContext(deps.recover);
}

async function stillEnabled(run: GsmRun): Promise<boolean> {
  const state = await getGsmState();
  return state.enabled && state.enabledAt === run.enabledAt;
}

async function loadOutbox(): Promise<GsmOutbox | null> {
  const stored = (await browser.storage.local.get(STORAGE_KEYS.GSM_OUTBOX))[STORAGE_KEYS.GSM_OUTBOX] as GsmOutbox | undefined;
  return stored ?? null;
}

async function writeOutbox(outbox: GsmOutbox | null): Promise<void> {
  await withStorageLock(() => outbox
    ? browser.storage.local.set({ [STORAGE_KEYS.GSM_OUTBOX]: outbox })
    : browser.storage.local.remove(STORAGE_KEYS.GSM_OUTBOX));
}

// false: stop this run
async function send(run: GsmRun, games: WireGame[], days: PlannedDay[]): Promise<boolean> {
  await awaitGsmCallGap();
  const server = run.server;
  if (!server || !await stillEnabled(run) || !await isContextStillCurrent(server)) return false;
  run.calls++;
  run.sent = true;
  const outcome = await postGsmSync(server, { dbId: run.dbId, enabledAt: utcString(run.enabledAt), games, days: days.map(d => d.wire) });
  if (outcome.kind === 'ok') {
    run.changed ||= outcome.changed;
    run.skipped += outcome.skipped;
    const sentIds = days.flatMap(day => day.wire.sessions.map(session => session.session_id));
    await applyLocalServerResult(sentIds, outcome.rejectedIds, outcome.keptDeleted, run.dayStartHour);
    for (const day of days) {
      const excluded = outcome.lbExcluded.get(day.wire.day_start_utc);
      if (excluded === undefined) continue;
      if (excluded > 0) run.lbExcluded[day.day] = excluded;
      else delete run.lbExcluded[day.day];
    }
    return true;
  }
  if (outcome.kind === 'invalid') {
    run.status = 'call_rejected';
    return true;
  }
  if (outcome.kind === 'auth') {
    if (!run.recovered) {
      run.recovered = true;
      const token = server.credential;
      const recovery = await deps.recover(await loadUserState());
      const refreshed = recovery.status === 'healed' ? await captureServerRequestContext() : null;
      if (refreshed?.credentialKind === 'token' && refreshed.credential !== token) {
        run.server = refreshed;
        return send(run, games, days);
      }
    }
    run.status = 'signed_out';
    return false;
  }
  run.status = 'server_unavailable';
  return false;
}

function withoutDeleted(days: PlannedDay[], deleted: Set<string>): PlannedDay[] {
  if (!deleted.size) return days;
  return days.map(day => ({ ...day, wire: { ...day.wire, sessions: day.wire.sessions.filter(session => !deleted.has(session.session_id)) } }));
}

// reads GSM and updates the local mirror; null stops the run
async function readRange(run: GsmRun, origin: string, first: string, last: string): Promise<GsmRead | null> {
  const today = localDayKey(Date.now());
  // one day of margin on both sides keeps sessions whole
  const lines = await fetchGsmLines(origin, addDays(first, -1), addDays(last, 1) > today ? today : addDays(last, 1));
  const mapped = await mapGsmGames(lines, run.games);
  if (mapped.games.length > MAX_CALL_GAMES) {
    run.status = 'too_many_games';
    return null;
  }
  const sessions = await gsmV1Sessions(mapped.lines);
  const plan = planGsmDays(sessions, mapped.lines, dayRange(first, last), { from: run.enabledAt }, mapped.games);
  run.skipped += plan.rejected;
  run.oversized += plan.oversized;
  if (!await stillEnabled(run)) return null;
  const days = withoutImportOverlaps(plan.days, await loadGsmImportStore(), run.enabledAt);
  await applyLocalDays(days, {
    enabledAt: run.enabledAt,
    dbId: run.dbId,
    archived: new Set(mapped.games.filter(game => game.archived).map(game => game.uuid)),
    titles: Object.fromEntries(mapped.games.map(game => [game.uuid, game.title || game.game_names[0] || ''])),
  }, run.dayStartHour);
  if (!run.server) return { days, games: mapped.games };
  return { days: withoutDeleted(days, await locallyDeletedIds()), games: mapped.games };
}

async function sendDays(run: GsmRun, read: GsmRead, maxCalls: number): Promise<{ sentThrough: string | null; stop: RangeStop }> {
  let sentThrough: string | null = null;
  for (const call of splitGsmCalls(read.days)) {
    if (run.calls >= maxCalls) return { sentThrough, stop: 'budget' };
    if (!await send(run, read.games, call)) return { sentThrough, stop: 'failed' };
    sentThrough = call[call.length - 1].day;
  }
  return { sentThrough, stop: null };
}

async function syncRange(run: GsmRun, origin: string, first: string, last: string, maxCalls: number): Promise<{ through: string; stop: RangeStop }> {
  const read = await readRange(run, origin, first, last);
  if (!read) return { through: addDays(first, -1), stop: 'failed' };
  if (!run.server) return { through: last, stop: null };
  const result = await sendDays(run, read, maxCalls);
  return { through: result.stop ? result.sentThrough ?? addDays(first, -1) : last, stop: result.stop };
}

async function readFingerprint(run: GsmRun, owner: number, read: GsmRead): Promise<string> {
  const games = [...read.games].sort((a, b) => (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0));
  return sha256Hex(JSON.stringify([owner, run.dbId, run.enabledAt, games, read.days.map(day => day.wire)]));
}

// at most every 5 min, and only when changed or stale
async function sendHot(run: GsmRun, read: GsmRead, state: GsmState, force: boolean, patch: Partial<GsmState>): Promise<boolean> {
  const server = run.server;
  if (!server) return true;
  const fingerprint = await readFingerprint(run, server.ownerUserId, read);
  const now = Date.now();
  const changed = fingerprint !== state.serverFingerprint;
  const due = force || (now - (state.serverTriedAt ?? 0) >= SEND_INTERVAL_MS
    && (changed || now - (state.serverSentAt ?? 0) >= REFRESH_INTERVAL_MS));
  const outbox: GsmOutbox = {
    fingerprint, owner: server.ownerUserId, enabledAt: run.enabledAt, dbId: run.dbId, games: read.games, days: read.days, flushTried: false,
  };
  if (!due) {
    const stored = await loadOutbox();
    if (!changed && stored) await writeOutbox(null);
    else if (changed && stored?.fingerprint !== fingerprint) await writeOutbox(outbox);
    return true;
  }
  patch.serverTriedAt = now;
  const result = await sendDays(run, read, Infinity);
  if (result.stop) {
    await writeOutbox(outbox);
    return false;
  }
  patch.serverFingerprint = fingerprint;
  patch.serverSentAt = Date.now();
  await writeOutbox(null);
  return true;
}

// GSM went away: the last unsent read goes out right away
async function flushOutbox(state: GsmState): Promise<void> {
  const outbox = await loadOutbox();
  if (!outbox || outbox.enabledAt !== state.enabledAt || outbox.dbId !== state.dbId) return;
  if (outbox.fingerprint === state.serverFingerprint) { await writeOutbox(null); return; }
  const triedAt = Date.now();
  if (outbox.flushTried && triedAt - (state.serverTriedAt ?? 0) < SEND_INTERVAL_MS) return;
  const server = await signedInContext();
  if (!server || server.ownerUserId !== outbox.owner) return;
  const settings = await deps.loadSettings();
  const run: GsmRun = {
    enabledAt: outbox.enabledAt, dbId: outbox.dbId, games: [], server, dayStartHour: settings.dayStartHour || 0, status: state.status,
    skipped: 0, oversized: 0, calls: 0, sent: false, changed: false, recovered: false, lbExcluded: { ...state.lbExcluded },
  };
  await writeOutbox({ ...outbox, flushTried: true });
  const result = await sendDays(run, { games: outbox.games, days: withoutDeleted(outbox.days, await locallyDeletedIds()) }, Infinity);
  const patch: Partial<GsmState> = { serverTriedAt: triedAt, lbExcluded: run.lbExcluded };
  if (!result.stop) {
    patch.serverFingerprint = outbox.fingerprint;
    patch.serverSentAt = Date.now();
    await writeOutbox(null);
  }
  await patchGsmState(patch, outbox.enabledAt);
  if (run.changed) deps.onServerChanged?.();
}

// cursor walks enabledAt..today in 14-day blocks
async function fullPass(run: GsmRun, origin: string, cursorAtStart: string | null, today: string): Promise<{ ok: boolean; wrapped: boolean }> {
  const startDay = localDayKey(run.enabledAt * 1000);
  const local = !run.server;
  const maxCalls = local ? Infinity : FULL_MAX_CALLS;
  let cursor = !local && cursorAtStart && cursorAtStart >= startDay && cursorAtStart <= today ? cursorAtStart : startDay;
  run.calls = 0;
  for (;;) {
    const blockEnd = addDays(cursor, FULL_BLOCK_DAYS - 1);
    const last = blockEnd > today ? today : blockEnd;
    const result = await syncRange(run, origin, cursor, last, maxCalls);
    const wrapped = !result.stop && last === today;
    cursor = wrapped ? startDay : addDays(result.through, 1);
    if (!local) await patchGsmState({ fullCursor: cursor }, run.enabledAt);
    if (result.stop === 'failed') return { ok: false, wrapped: false };
    if (wrapped) return { ok: true, wrapped: true };
    if (result.stop || run.calls >= maxCalls) return { ok: true, wrapped: false };
  }
}

async function tick(full: boolean, force: boolean): Promise<void> {
  const state = await getGsmState();
  if (!state.enabled || state.enabledAt === null) { await arm(false, 0); return; }
  const access = await gsmAccess();
  if (access.status !== 'ok') {
    await patchGsmState({ status: access.status });
    await arm(false, 0);
    return;
  }
  let games: GsmGame[];
  let origin: string;
  try {
    const opened = await openGsm(gsmCandidatePorts(state.port, access.ports));
    games = opened.games;
    origin = gsmOrigin(opened.port);
    if (opened.port !== state.port) await patchGsmState({ port: opened.port }, state.enabledAt);
  } catch (error) {
    const failures = Math.min(BACKOFF_FAILURES, state.failures + 1);
    await patchGsmState({ status: error instanceof GsmReadError ? error.kind : 'unreachable', failures });
    await arm(true, failures);
    await flushOutbox(state);
    return;
  }
  await arm(true, 0);
  const identity = resolveGsmDbIdentity(state.dbId, state.knownGameUuids, games.map(game => game.uuid));
  if (!identity) {
    await patchGsmState({ status: 'no_games', failures: 0 });
    return;
  }
  if (identity.changed || state.failures || identity.knownGameUuids.join('\n') !== state.knownGameUuids.join('\n')) {
    await patchGsmState({ dbId: identity.dbId, knownGameUuids: identity.knownGameUuids, failures: 0 }, state.enabledAt);
  }
  const server = await signedInContext();
  const settings = await deps.loadSettings();
  const tokenLost = !server && !!(await loadUserState())?.isLoggedIn;
  const run: GsmRun = {
    enabledAt: state.enabledAt, dbId: identity.dbId, games, server, dayStartHour: settings.dayStartHour || 0,
    status: server ? 'ok' : tokenLost ? 'signed_out' : 'local', skipped: 0, oversized: 0, calls: 0, sent: false, changed: false,
    recovered: false, lbExcluded: server ? { ...state.lbExcluded } : {},
  };
  const startedAt = Date.now();
  const today = localDayKey(startedAt);
  const enabledDay = localDayKey(state.enabledAt * 1000);
  const yesterday = addDays(today, -1);
  const patch: Partial<GsmState> = {};
  const owner = server?.ownerUserId ?? null;
  let cursor = state.fullCursor;
  if (owner === null) {
    patch.serverOwner = null;
    patch.catchUpOwner = null;
  } else if (state.serverOwner !== owner && state.catchUpOwner !== owner) {
    cursor = enabledDay;
    run.lbExcluded = {};
    await patchGsmState({ catchUpOwner: owner, fullCursor: cursor, lbExcluded: {} }, run.enabledAt);
  }
  const catchUp = owner !== null && state.serverOwner !== owner;
  try {
    const read = await readRange(run, origin, yesterday > enabledDay ? yesterday : enabledDay, today);
    if (read) {
      patch.lastHot = Date.now();
      await settleGsmImportDeferred({ enabledAt: run.enabledAt, dbId: run.dbId, games, origin }).catch(() => {});
      if (await sendHot(run, read, state, force, patch)) {
        const due = catchUp || full || !state.lastFull || startedAt - state.lastFull >= FULL_INTERVAL_MS;
        const pass = due ? await fullPass(run, origin, cursor, today) : null;
        if (pass?.ok) patch.lastFull = Date.now();
        if (catchUp && pass?.wrapped) {
          patch.serverOwner = owner;
          patch.catchUpOwner = null;
        }
      }
    }
  } catch (error) {
    if (!(error instanceof GsmReadError)) throw error;
    run.status = error.kind;
  } finally {
    // without a send the server part of the counts is unknown
    const counts = !run.server || run.sent ? { rejectedCount: run.skipped, oversizedDays: run.oversized } : {};
    await patchGsmState({ ...patch, ...counts, status: run.status, lbExcluded: run.lbExcluded }, run.enabledAt);
    if (run.changed) deps.onServerChanged?.();
  }
}

export function syncGsm(full: boolean, force = false): Promise<void> {
  queued = true;
  if (full) queuedFull = true;
  if (force) queuedForce = true;
  if (!running) {
    running = (async () => {
      while (queued) {
        queued = false;
        const nextFull = queuedFull;
        const nextForce = queuedForce;
        queuedFull = false;
        queuedForce = false;
        await tick(nextFull, nextForce).catch(() => {});
      }
    })().finally(() => { running = null; });
  }
  return running;
}

export async function setGsmEnabled(enabled: boolean): Promise<GsmState> {
  await writeGsmEnabled(enabled);
  if (!enabled) {
    await browser.alarms.clear(GSM_ALARM);
    return getGsmState();
  }
  const access = await gsmAccess();
  if (access.status !== 'ok') {
    await arm(false, 0);
    return patchGsmState({ status: access.status });
  }
  await arm(true, 0);
  void syncGsm(true);
  return getGsmState();
}

async function refreshAccess(): Promise<void> {
  const state = await getGsmState();
  if (!state.enabled) { await arm(false, 0); return; }
  const access = await gsmAccess();
  if (access.status !== 'ok') {
    await patchGsmState({ status: access.status });
    await arm(false, 0);
    return;
  }
  await arm(true, state.failures);
  if (state.status === 'permission_needed') void syncGsm(false);
}

export function initGsmPoller(callbacks: GsmDeps): void {
  deps = callbacks;
  browser.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === GSM_ALARM) void syncGsm(false);
  });
  browser.runtime.onStartup.addListener(() => { void syncGsm(true); });
  browser.storage.onChanged.addListener((changes, area) => {
    const change = area === 'local' ? changes[STORAGE_KEYS.USER] : undefined;
    if (!change) return;
    const before = change.oldValue as JP343UserState | undefined;
    const after = change.newValue as JP343UserState | undefined;
    if (stableUserId(before) !== stableUserId(after) || !!before?.extApiToken !== !!after?.extApiToken) void syncGsm(false);
  });
  browser.permissions.onRemoved.addListener(() => { void refreshAccess().catch(() => {}); });
  browser.permissions.onAdded.addListener(() => { void refreshAccess().catch(() => {}); });
  void refreshAccess().catch(() => {});
}
