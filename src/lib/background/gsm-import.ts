import type { ExtensionSettings, JP343UserState, PendingEntry } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { stableUserId } from '../auth-helpers';
import type { GsmGame } from '../gsm/api';
import { fetchGsmFirstLineDay, fetchGsmGames, fetchGsmLines, GsmReadError } from '../gsm/api';
import { resolveGsmDbIdentity } from '../gsm/db-identity';
import type {
  GsmImportCounts, GsmImportDiff, GsmImportError, GsmImportItem, GsmImportPreview, GsmImportStore, GsmImportUploadStatus,
} from '../gsm/import';
import {
  addGsmImportSessions, applyGsmImportOutcome, buildGsmImportCalls, classifyGsmImport, clearGsmImportDeferred, countGsmImport,
  deleteGsmImportSession, gsmImportViewEntries, hasGsmImportPending, refreshGsmImportCall, restoreGsmImportSession,
  setGsmImportUploadStatus, summarizeGsmImport, toGsmImportStore,
} from '../gsm/import';
import type { PlannedDay, WireGame } from '../gsm/payload';
import { addDays, dayRange, localDayKey, mapGsmGames, MAX_CALL_GAMES, planGsmDays } from '../gsm/payload';
import { gsmV1Sessions } from '../gsm/rule';
import { captureServerRequestContext, isContextStillCurrent, loadUserState } from '../server-cache';
import type { AuthRecoveryResult } from './auth-recovery';
import { buildStashedSnapshots } from './deleted-entries';
import { getGsmState } from './gsm-connect';
import { commitGsmStore, loadGsmLocalStore } from './gsm-local';
import { awaitGsmCallGap, gsmSignedInContext, postGsmImport } from './gsm-sync';

export const GSM_IMPORT_ALARM = 'jp343-gsm-import';
const UPLOAD_PERIOD_MINUTES = 5;
const MAX_UPLOAD_CALLS = 10;
const BLOCK_DAYS = 14;
const DEFERRED_CHECK_MS = 5 * 60_000;
const DEFERRED_MAX_DAYS = 14;
const MAX_SELECTED_GAMES = 5000;

interface GsmImportDeps {
  createAlarmSafe: (name: string, options: { periodInMinutes: number }) => void;
  recover: (user?: JP343UserState | null) => Promise<AuthRecoveryResult>;
  loadSettings: () => Promise<ExtensionSettings>;
  onServerChanged?: () => void;
}

interface ScanContext {
  enabledAt: number;
  dbId: string;
  games: GsmGame[];
}

class GsmImportScanError extends Error {
  constructor(readonly code: GsmImportError) {
    super(code);
  }
}

let deps: GsmImportDeps;
let uploading: Promise<void> | null = null;
let uploadAgain = false;

export async function loadGsmImportStore(): Promise<GsmImportStore> {
  return toGsmImportStore((await browser.storage.local.get(STORAGE_KEYS.GSM_IMPORT))[STORAGE_KEYS.GSM_IMPORT]);
}

function commit(
  dayStartHour: number,
  change: (store: GsmImportStore) => GsmImportDiff | null | Promise<GsmImportDiff | null>,
  extra?: (diff: GsmImportDiff) => Promise<Record<string, unknown>>
): Promise<GsmImportDiff | null> {
  return commitGsmStore(STORAGE_KEYS.GSM_IMPORT, loadGsmImportStore, dayStartHour, change, extra);
}

async function dayStartHour(): Promise<number> {
  return (await deps.loadSettings()).dayStartHour || 0;
}

function readError(error: unknown): GsmImportScanError {
  if (error instanceof GsmImportScanError) return error;
  return new GsmImportScanError(error instanceof GsmReadError ? error.kind : 'unreachable');
}

// 14-day blocks with one day of margin, like the sync
async function scanHistory(ctx: ScanContext, first: string, last: string): Promise<{ days: PlannedDay[]; games: WireGame[] }> {
  const today = localDayKey(Date.now());
  const days: PlannedDay[] = [];
  const games = new Map<string, WireGame>();
  for (let cursor = first; cursor <= last; cursor = addDays(cursor, BLOCK_DAYS)) {
    const blockEnd = addDays(cursor, BLOCK_DAYS - 1);
    const end = blockEnd > last ? last : blockEnd;
    const to = addDays(end, 1) > today ? today : addDays(end, 1);
    const lines = await fetchGsmLines(addDays(cursor, -1), to);
    const mapped = await mapGsmGames(lines, ctx.games);
    if (mapped.games.length > MAX_CALL_GAMES) throw new GsmImportScanError('too_many_games');
    const sessions = await gsmV1Sessions(mapped.lines);
    days.push(...planGsmDays(sessions, mapped.lines, dayRange(cursor, end), { before: ctx.enabledAt }, mapped.games).days);
    for (const game of mapped.games) games.set(game.uuid, game);
  }
  return { days, games: [...games.values()] };
}

// null: GSM has no games yet
async function scanContext(): Promise<ScanContext | null> {
  const state = await getGsmState();
  if (!state.enabled || state.enabledAt === null) throw new GsmImportScanError('not_enabled');
  let games: GsmGame[];
  try {
    games = await fetchGsmGames();
  } catch (error) {
    throw readError(error);
  }
  const identity = resolveGsmDbIdentity(state.dbId, state.knownGameUuids, games.map(game => game.uuid));
  if (!identity) return null;
  if (identity.changed || !state.dbId) throw new GsmImportScanError('not_ready');
  return { enabledAt: state.enabledAt, dbId: state.dbId, games };
}

async function scanItems(ctx: ScanContext, first: string | null): Promise<{ items: GsmImportItem[]; games: WireGame[] }> {
  const enabledDay = localDayKey(ctx.enabledAt * 1000);
  try {
    const from = first ?? await fetchGsmFirstLineDay(enabledDay);
    if (!from) return { items: [], games: [] };
    const scan = await scanHistory(ctx, from > enabledDay ? enabledDay : from, enabledDay);
    const items = classifyGsmImport(scan.days, await loadGsmLocalStore(), await loadGsmImportStore(), {
      dbId: ctx.dbId, enabledAt: ctx.enabledAt, now: Date.now(),
    });
    return { items, games: scan.games };
  } catch (error) {
    throw readError(error);
  }
}

async function addItems(ctx: ScanContext, items: GsmImportItem[], games: WireGame[], selected: Set<string>): Promise<void> {
  await commit(await dayStartHour(), async store => addGsmImportSessions(store, await loadGsmLocalStore(), items, games, {
    enabledAt: ctx.enabledAt, selected, now: Date.now(),
  }));
  if (hasGsmImportPending(await loadGsmImportStore())) void uploadGsmImport();
}

export async function previewGsmImport(): Promise<{ ok: true; preview: GsmImportPreview } | { ok: false; error: GsmImportError }> {
  try {
    const ctx = await scanContext();
    if (!ctx) return { ok: true, preview: { enabledAt: (await getGsmState()).enabledAt ?? 0, games: [] } };
    const { items, games } = await scanItems(ctx, null);
    return { ok: true, preview: { enabledAt: ctx.enabledAt, games: summarizeGsmImport(items, games) } };
  } catch (error) {
    return { ok: false, error: readError(error).code };
  }
}

export async function startGsmImport(selectedGames: unknown): Promise<{ ok: true; counts: GsmImportCounts } | { ok: false; error: GsmImportError }> {
  const selected = new Set(Array.isArray(selectedGames)
    ? selectedGames.filter((uuid): uuid is string => typeof uuid === 'string').slice(0, MAX_SELECTED_GAMES)
    : []);
  try {
    const ctx = await scanContext();
    if (ctx && selected.size) {
      const { items, games } = await scanItems(ctx, null);
      await addItems(ctx, items, games, selected);
    }
    return { ok: true, counts: countGsmImport(await loadGsmImportStore()) };
  } catch (error) {
    return { ok: false, error: readError(error).code };
  }
}

// poller hook: imports deferred sessions once they rest
export async function settleGsmImportDeferred(input: { enabledAt: number; dbId: string; games: GsmGame[] }): Promise<void> {
  const store = await loadGsmImportStore();
  if (!store.deferred.length) return;
  const now = Date.now();
  const first = addDays(localDayKey(input.enabledAt * 1000), -1);
  if (store.enabledAt !== input.enabledAt || dayRange(first, localDayKey(now)).length > DEFERRED_MAX_DAYS) {
    await commit(await dayStartHour(), current => clearGsmImportDeferred(current, now));
    return;
  }
  if (store.deferredCheckedAt !== null && now - store.deferredCheckedAt < DEFERRED_CHECK_MS) return;
  const ctx: ScanContext = { enabledAt: input.enabledAt, dbId: input.dbId, games: input.games };
  const { items, games } = await scanItems(ctx, first);
  await addItems(ctx, items, games, new Set(store.deferred));
}

export async function getGsmImportStatus(): Promise<GsmImportCounts> {
  return countGsmImport(await loadGsmImportStore());
}

export async function loadGsmImportViewEntries(): Promise<PendingEntry[]> {
  return gsmImportViewEntries(await loadGsmImportStore());
}

export async function deleteGsmImportEntry(sessionId: string, dayStartHourValue: number): Promise<boolean> {
  const diff = await commit(
    dayStartHourValue,
    store => deleteGsmImportSession(store, sessionId),
    async next => ({ [STORAGE_KEYS.DELETED_ENTRIES]: await buildStashedSnapshots(next.subtract[0]) })
  );
  return diff !== null;
}

export async function restoreGsmImportEntry(sessionId: string, dayStartHourValue: number): Promise<boolean> {
  const diff = await commit(dayStartHourValue, store => restoreGsmImportSession(store, sessionId));
  const session = (await loadGsmImportStore()).sessions[sessionId];
  if (session?.state === 'pending') void uploadGsmImport();
  return diff !== null || (session !== undefined && session.state !== 'deleted' && session.state !== 'server_deleted');
}

async function armUpload(on: boolean): Promise<void> {
  if (!on) { await browser.alarms.clear(GSM_IMPORT_ALARM); return; }
  const alarm = await browser.alarms.get(GSM_IMPORT_ALARM);
  if (alarm?.periodInMinutes !== UPLOAD_PERIOD_MINUTES) deps.createAlarmSafe(GSM_IMPORT_ALARM, { periodInMinutes: UPLOAD_PERIOD_MINUTES });
}

async function uploadOnce(): Promise<void> {
  const store = await loadGsmImportStore();
  if (!hasGsmImportPending(store)) { await armUpload(false); return; }
  await armUpload(true);
  const dsh = await dayStartHour();
  const setStatus = (status: GsmImportUploadStatus): Promise<GsmImportDiff | null> =>
    commit(dsh, current => setGsmImportUploadStatus(current, status));
  let server = await gsmSignedInContext(deps.recover);
  if (!server) { await setStatus('signed_out'); return; }
  const owner = server.ownerUserId;
  const calls = buildGsmImportCalls(store, owner).slice(0, MAX_UPLOAD_CALLS);
  if (!calls.length) { await setStatus('other_account'); return; }
  let status: GsmImportUploadStatus = 'ok';
  let recovered = false;
  let inserted = false;
  for (const planned of calls) {
    const call = refreshGsmImportCall(await loadGsmImportStore(), planned, owner);
    if (!call) continue;
    await awaitGsmCallGap();
    if (!await isContextStillCurrent(server)) { status = 'signed_out'; break; }
    let outcome = await postGsmImport(server, call);
    if (outcome.kind === 'auth' && !recovered) {
      recovered = true;
      const token = server.credential;
      const recovery = await deps.recover(await loadUserState());
      const refreshed = recovery.status === 'healed' ? await captureServerRequestContext() : null;
      if (refreshed?.credentialKind === 'token' && refreshed.credential !== token && refreshed.ownerUserId === owner) {
        server = refreshed;
        await awaitGsmCallGap();
        outcome = await postGsmImport(server, call);
      }
    }
    if (outcome.kind === 'auth') { status = 'signed_out'; break; }
    if (outcome.kind === 'retry') { status = 'server_unavailable'; break; }
    if (outcome.kind === 'ok' && outcome.days.some(day => day.inserted > 0)) inserted = true;
    const result = outcome;
    await commit(dsh, current => applyGsmImportOutcome(current, call, result, owner, Date.now()));
  }
  await setStatus(status);
  if (inserted) deps.onServerChanged?.();
  if (!hasGsmImportPending(await loadGsmImportStore())) await armUpload(false);
}

export function uploadGsmImport(): Promise<void> {
  uploadAgain = true;
  if (!uploading) {
    uploading = (async () => {
      while (uploadAgain) {
        uploadAgain = false;
        await uploadOnce().catch(() => {});
      }
    })().finally(() => { uploading = null; });
  }
  return uploading;
}

export function initGsmImport(callbacks: GsmImportDeps): void {
  deps = callbacks;
  browser.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === GSM_IMPORT_ALARM) void uploadGsmImport();
  });
  browser.storage.onChanged.addListener((changes, area) => {
    const change = area === 'local' ? changes[STORAGE_KEYS.USER] : undefined;
    if (!change) return;
    const before = change.oldValue as JP343UserState | undefined;
    const after = change.newValue as JP343UserState | undefined;
    if (stableUserId(before) !== stableUserId(after) || !!before?.extApiToken !== !!after?.extApiToken) void uploadGsmImport();
  });
  void uploadGsmImport();
}
