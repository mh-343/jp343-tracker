import type { PendingEntry } from '../../types';
import { isJapaneseGsmSession } from './classify';
import type { GsmLocalStore, GsmStoreDiff } from './local-mirror';
import { gsmStatEntry, isGsmSessionId, wireSeconds } from './local-mirror';
import type { PlannedDay, WireDay, WireGame, WireSession } from './payload';
import { isValidGameUuid, isValidGsmChars, localDayKey, MAX_CALL_DAYS, MAX_CALL_SESSIONS, utcString } from './payload';

// a session whose last line is younger may still be running
export const GSM_IMPORT_LATER_S = 1800;
export const GSM_IMPORT_MAX_ATTEMPTS = 5;

export type GsmImportState = 'pending' | 'uploaded' | 'deleted' | 'server_deleted' | 'rejected' | 'failed';
type GsmImportCounted = 'pending' | 'uploaded' | 'rejected' | 'failed';
export type GsmImportUploadStatus = 'ok' | 'signed_out' | 'server_unavailable' | 'other_account' | null;

export interface GsmImportSession {
  dbId: string;
  game: string;
  // epoch seconds, as on the wire
  start: number;
  end: number;
  seconds: number;
  linesScript: number;
  linesKana: number;
  chars?: number;
  // import boundary, sent as enabled_at
  enabledAt: number;
  dayStartUtc: string;
  dayEndUtc: string;
  state: GsmImportState;
  restoreTo?: GsmImportCounted;
  attempts: number;
  // account it was uploaded to; null until then
  owner: number | null;
  uploadedAt: number | null;
}

export interface GsmImportStore {
  // boundary of the last import, for deferred sessions
  enabledAt: number | null;
  deferred: string[];
  deferredCheckedAt: number | null;
  uploadStatus: GsmImportUploadStatus;
  games: Record<string, WireGame>;
  sessions: Record<string, GsmImportSession>;
}

export type GsmImportDiff = GsmStoreDiff<GsmImportStore>;

export type GsmImportKind = 'new' | 'existing' | 'overlap' | 'later';

export interface GsmImportItem {
  kind: GsmImportKind;
  sessionId: string;
  session: GsmImportSession;
}

export interface GsmImportGameSummary {
  uuid: string;
  title: string;
  archived: boolean;
  sessions: number;
  seconds: number;
  firstDay: string | null;
  lastDay: string | null;
  fresh: number;
  freshSeconds: number;
  existing: number;
  overlapping: number;
  later: number;
  notJapanese: number;
}

export type GsmImportError = 'not_enabled' | 'not_ready' | 'unreachable' | 'unsupported' | 'too_many_games';

export interface GsmImportPreview {
  enabledAt: number;
  games: GsmImportGameSummary[];
}

export interface GsmImportCall {
  dbId: string;
  enabledAt: number;
  games: WireGame[];
  days: WireDay[];
}

export interface GsmImportDayResult {
  dayStartUtc: string;
  inserted: number;
  failedIds: Set<string>;
  // kept_deleted_ids and overlap_ids
  goneIds: Set<string>;
  rejectedIds: Set<string>;
}

export type GsmImportOutcome =
  | { kind: 'ok'; days: GsmImportDayResult[] }
  | { kind: 'auth' }
  | { kind: 'invalid' }
  | { kind: 'retry'; code: string };

export interface GsmImportCounts {
  sessions: number;
  seconds: number;
  pending: number;
  uploaded: number;
  deleted: number;
  serverDeleted: number;
  rejected: number;
  failed: number;
  notJapanese: number;
  deferredGames: number;
  uploadStatus: GsmImportUploadStatus;
}

const STATES: readonly GsmImportState[] = ['pending', 'uploaded', 'deleted', 'server_deleted', 'rejected', 'failed'];
const COUNTED: readonly GsmImportState[] = ['pending', 'uploaded', 'rejected', 'failed'];

export function emptyGsmImportStore(): GsmImportStore {
  return { enabledAt: null, deferred: [], deferredCheckedAt: null, uploadStatus: null, games: {}, sessions: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isCounted(state: GsmImportState): state is GsmImportCounted {
  return COUNTED.includes(state);
}

function isImportSession(value: unknown): value is GsmImportSession {
  if (!isRecord(value)) return false;
  return typeof value.dbId === 'string' && typeof value.game === 'string'
    && Number.isFinite(value.start) && Number.isFinite(value.end) && Number.isFinite(value.seconds)
    && isCount(value.linesScript) && isCount(value.linesKana) && Number.isFinite(value.enabledAt)
    && (value.chars === undefined || isValidGsmChars(value.chars))
    && typeof value.dayStartUtc === 'string' && typeof value.dayEndUtc === 'string'
    && STATES.includes(value.state as GsmImportState)
    && (value.restoreTo === undefined || COUNTED.includes(value.restoreTo as GsmImportState))
    && isCount(value.attempts)
    && (value.owner === null || isCount(value.owner))
    && (value.uploadedAt === null || Number.isFinite(value.uploadedAt));
}

function isWireGame(value: unknown): value is WireGame {
  if (!isRecord(value)) return false;
  return typeof value.uuid === 'string' && isValidGameUuid(value.uuid) && typeof value.title === 'string'
    && (value.vndb_id === null || typeof value.vndb_id === 'string' || typeof value.vndb_id === 'number')
    && Array.isArray(value.game_names) && value.game_names.every(name => typeof name === 'string')
    && typeof value.archived === 'boolean';
}

export function toGsmImportStore(raw: unknown): GsmImportStore {
  const store = emptyGsmImportStore();
  if (!isRecord(raw)) return store;
  if (Number.isFinite(raw.enabledAt)) store.enabledAt = Number(raw.enabledAt);
  if (Array.isArray(raw.deferred)) store.deferred = raw.deferred.filter((uuid): uuid is string => typeof uuid === 'string');
  if (Number.isFinite(raw.deferredCheckedAt)) store.deferredCheckedAt = Number(raw.deferredCheckedAt);
  if (raw.uploadStatus === 'ok' || raw.uploadStatus === 'signed_out' || raw.uploadStatus === 'server_unavailable' || raw.uploadStatus === 'other_account') {
    store.uploadStatus = raw.uploadStatus;
  }
  if (isRecord(raw.games)) {
    for (const [uuid, game] of Object.entries(raw.games)) if (isWireGame(game) && game.uuid === uuid) store.games[uuid] = game;
  }
  if (isRecord(raw.sessions)) {
    for (const [sid, session] of Object.entries(raw.sessions)) if (isGsmSessionId(sid) && isImportSession(session)) store.sessions[sid] = session;
  }
  return store;
}

function copyStore(store: GsmImportStore): GsmImportStore {
  return { ...store, deferred: [...store.deferred], games: { ...store.games }, sessions: { ...store.sessions } };
}

function gameTitle(game: WireGame | undefined): string {
  return game ? game.title || game.game_names[0] || '' : '';
}

function statEntry(store: GsmImportStore, sessionId: string, session: GsmImportSession): PendingEntry {
  return gsmStatEntry(sessionId, session, gameTitle(store.games[session.game]));
}

// spans of every session this browser already knows, any state
export function knownGsmSpans(local: GsmLocalStore, store: GsmImportStore): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const session of Object.values(local.sessions)) spans.push([session.start, session.end ?? session.start + session.seconds]);
  for (const session of Object.values(store.sessions)) spans.push([session.start, session.end]);
  return spans;
}

function overlapsAny(start: number, end: number, spans: Array<[number, number]>): boolean {
  return spans.some(([a, b]) => start < b && a < end);
}

function importSession(wire: WireSession, day: WireDay, dbId: string, enabledAt: number): GsmImportSession {
  return {
    dbId, game: wire.game_uuid, start: wireSeconds(wire.start_utc), end: wireSeconds(wire.end_utc), seconds: wire.duration_seconds,
    linesScript: wire.lines_script, linesKana: wire.lines_kana, enabledAt, dayStartUtc: day.day_start_utc, dayEndUtc: day.day_end_utc,
    state: 'pending', attempts: 0, owner: null, uploadedAt: null,
    ...(isValidGsmChars(wire.chars) ? { chars: wire.chars } : {}),
  };
}

// days come from planGsmDays with { before: enabledAt }
export function classifyGsmImport(
  days: PlannedDay[],
  local: GsmLocalStore,
  store: GsmImportStore,
  ctx: { dbId: string; enabledAt: number; now: number }
): GsmImportItem[] {
  const spans = knownGsmSpans(local, store);
  const items: GsmImportItem[] = [];
  for (const day of days) {
    for (const wire of day.wire.sessions) {
      const session = importSession(wire, day.wire, ctx.dbId, ctx.enabledAt);
      const sessionId = wire.session_id;
      let kind: GsmImportKind = 'new';
      if (local.sessions[sessionId] || store.sessions[sessionId]) kind = 'existing';
      else if (overlapsAny(session.start, session.end, spans)) kind = 'overlap';
      else if (ctx.now / 1000 - session.end < GSM_IMPORT_LATER_S) kind = 'later';
      items.push({ kind, sessionId, session });
    }
  }
  return items;
}

export function summarizeGsmImport(items: GsmImportItem[], games: WireGame[]): GsmImportGameSummary[] {
  const byGame = new Map<string, GsmImportGameSummary>();
  for (const game of games) {
    byGame.set(game.uuid, {
      uuid: game.uuid, title: gameTitle(game), archived: game.archived, sessions: 0, seconds: 0, firstDay: null, lastDay: null,
      fresh: 0, freshSeconds: 0, existing: 0, overlapping: 0, later: 0, notJapanese: 0,
    });
  }
  for (const { kind, session } of items) {
    const summary = byGame.get(session.game);
    if (!summary) continue;
    const day = localDayKey(session.start * 1000);
    summary.sessions++;
    summary.seconds += session.seconds;
    if (summary.firstDay === null || day < summary.firstDay) summary.firstDay = day;
    if (summary.lastDay === null || day > summary.lastDay) summary.lastDay = day;
    if (kind === 'new') {
      summary.fresh++;
      summary.freshSeconds += session.seconds;
      if (!isJapaneseGsmSession(session.linesScript, session.linesKana)) summary.notJapanese++;
    } else if (kind === 'existing') summary.existing++;
    else if (kind === 'overlap') summary.overlapping++;
    else summary.later++;
  }
  return [...byGame.values()].filter(summary => summary.sessions > 0).sort((a, b) => b.seconds - a.seconds);
}

// rechecked under the lock against a newer store
export function addGsmImportSessions(
  store: GsmImportStore,
  local: GsmLocalStore,
  items: GsmImportItem[],
  games: WireGame[],
  ctx: { enabledAt: number; selected: Set<string>; now: number }
): GsmImportDiff {
  const next = copyStore(store);
  const add: PendingEntry[] = [];
  const spans = knownGsmSpans(local, store);
  const later = new Set<string>();
  let changed = false;
  if (next.enabledAt !== ctx.enabledAt) {
    next.enabledAt = ctx.enabledAt;
    next.deferred = [];
    changed = true;
  }
  for (const game of games) {
    if (!ctx.selected.has(game.uuid)) continue;
    const old = next.games[game.uuid];
    if (old && JSON.stringify(old) === JSON.stringify(game)) continue;
    next.games[game.uuid] = game;
    changed = true;
  }
  for (const { kind, sessionId, session } of items) {
    if (!ctx.selected.has(session.game)) continue;
    if (kind === 'later') { later.add(session.game); continue; }
    if (kind !== 'new' || local.sessions[sessionId] || next.sessions[sessionId]) continue;
    if (overlapsAny(session.start, session.end, spans)) continue;
    next.sessions[sessionId] = session;
    spans.push([session.start, session.end]);
    add.push(statEntry(next, sessionId, session));
    changed = true;
  }
  const deferred = new Set(next.deferred.filter(uuid => !ctx.selected.has(uuid)));
  for (const uuid of later) deferred.add(uuid);
  const sortedDeferred = [...deferred].sort();
  if (sortedDeferred.join('\n') !== next.deferred.join('\n')) {
    next.deferred = sortedDeferred;
    changed = true;
  }
  if (next.deferredCheckedAt !== ctx.now) {
    next.deferredCheckedAt = ctx.now;
    changed = true;
  }
  return { store: next, add, subtract: [], changed };
}

function uploadable(session: GsmImportSession, owner: number): boolean {
  return session.state === 'pending' && (session.owner === null || session.owner === owner);
}

export function hasGsmImportPending(store: GsmImportStore): boolean {
  return Object.values(store.sessions).some(session => session.state === 'pending');
}

// days never overlap inside one call
export function buildGsmImportCalls(store: GsmImportStore, owner: number): GsmImportCall[] {
  const groups = new Map<string, Array<[string, GsmImportSession]>>();
  for (const [sid, session] of Object.entries(store.sessions)) {
    if (!uploadable(session, owner)) continue;
    const key = `${session.dbId}|${session.enabledAt}`;
    const list = groups.get(key);
    if (list) list.push([sid, session]);
    else groups.set(key, [[sid, session]]);
  }
  const calls: GsmImportCall[] = [];
  for (const [key, list] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const [dbId, enabledAt] = key.split('|');
    list.sort(([, a], [, b]) => (a.dayStartUtc < b.dayStartUtc ? -1 : a.dayStartUtc > b.dayStartUtc ? 1 : a.start - b.start));
    let days: WireDay[] = [];
    let sessions = 0;
    let lastEnd = '';
    const flush = (): void => {
      if (!days.length) return;
      const uuids = new Set(days.flatMap(day => day.sessions.map(session => session.game_uuid)));
      const wireGames = [...uuids].sort().map(uuid => store.games[uuid]).filter((game): game is WireGame => game !== undefined);
      calls.push({ dbId, enabledAt: Number(enabledAt), games: wireGames, days });
      days = [];
      sessions = 0;
      lastEnd = '';
    };
    for (const [sid, session] of list) {
      let day = days[days.length - 1];
      const sameDay = day && day.day_start_utc === session.dayStartUtc && day.day_end_utc === session.dayEndUtc;
      if (sessions >= MAX_CALL_SESSIONS || (!sameDay && (days.length >= MAX_CALL_DAYS || (lastEnd && session.dayStartUtc < lastEnd)))) {
        flush();
        day = days[days.length - 1];
      }
      if (!day || day.day_start_utc !== session.dayStartUtc || day.day_end_utc !== session.dayEndUtc) {
        day = { day_start_utc: session.dayStartUtc, day_end_utc: session.dayEndUtc, sessions: [] };
        days.push(day);
        lastEnd = session.dayEndUtc;
      }
      day.sessions.push({
        session_id: sid, game_uuid: session.game, start_utc: utcString(session.start), end_utc: utcString(session.end),
        duration_seconds: session.seconds, lines_script: session.linesScript, lines_kana: session.linesKana,
        ...(isValidGsmChars(session.chars) ? { chars: session.chars } : {}),
      });
      sessions++;
    }
    flush();
  }
  return calls;
}

// drops sessions that changed since the calls were built
export function refreshGsmImportCall(store: GsmImportStore, call: GsmImportCall, owner: number): GsmImportCall | null {
  const days = call.days
    .map(day => ({ ...day, sessions: day.sessions.filter(wire => {
      const session = store.sessions[wire.session_id];
      return session !== undefined && uploadable(session, owner);
    }) }))
    .filter(day => day.sessions.length > 0);
  return days.length ? { ...call, days } : null;
}

export function clearGsmImportDeferred(store: GsmImportStore, now: number): GsmImportDiff | null {
  if (!store.deferred.length) return null;
  return { store: { ...copyStore(store), deferred: [], deferredCheckedAt: now }, add: [], subtract: [], changed: true };
}

function failAttempt(session: GsmImportSession): GsmImportSession {
  const attempts = session.attempts + 1;
  return { ...session, attempts, state: attempts >= GSM_IMPORT_MAX_ATTEMPTS ? 'failed' : 'pending' };
}

// touches only sessions still waiting for this upload
export function applyGsmImportOutcome(
  store: GsmImportStore,
  call: GsmImportCall,
  outcome: GsmImportOutcome,
  owner: number,
  now: number
): GsmImportDiff {
  const next = copyStore(store);
  const subtract: PendingEntry[] = [];
  let changed = false;
  if (outcome.kind === 'auth' || outcome.kind === 'retry') return { store: next, add: [], subtract, changed };
  const results = outcome.kind === 'ok' ? new Map(outcome.days.map(day => [day.dayStartUtc, day])) : null;
  for (const day of call.days) {
    const result = results?.get(day.day_start_utc);
    if (results && !result) continue;
    for (const wire of day.sessions) {
      const sid = wire.session_id;
      const session = next.sessions[sid];
      if (!session) continue;
      const deleted = session.state === 'deleted';
      if (session.state !== 'pending' && !(deleted && session.restoreTo === 'pending')) continue;
      const base: GsmImportSession = { ...session, state: 'pending', restoreTo: undefined };
      let done: GsmImportSession;
      if (!result || result.failedIds.has(sid)) done = failAttempt(base);
      else if (result.goneIds.has(sid)) done = { ...base, state: 'server_deleted', owner };
      else if (result.rejectedIds.has(sid)) done = { ...base, state: 'rejected' };
      else done = { ...base, state: 'uploaded', owner, uploadedAt: now };
      if (deleted && isCounted(done.state)) next.sessions[sid] = { ...done, state: 'deleted', restoreTo: done.state };
      else next.sessions[sid] = done;
      if (!deleted && done.state === 'server_deleted') subtract.push(statEntry(next, sid, session));
      changed = true;
    }
  }
  return { store: next, add: [], subtract, changed };
}

export function setGsmImportUploadStatus(store: GsmImportStore, status: GsmImportUploadStatus): GsmImportDiff | null {
  if (store.uploadStatus === status) return null;
  return { store: { ...copyStore(store), uploadStatus: status }, add: [], subtract: [], changed: true };
}

export function deleteGsmImportSession(store: GsmImportStore, sessionId: string): GsmImportDiff | null {
  const session = store.sessions[sessionId];
  if (!session || !isCounted(session.state)) return null;
  const next = copyStore(store);
  next.sessions[sessionId] = { ...session, state: 'deleted', restoreTo: session.state };
  return { store: next, add: [], subtract: [statEntry(next, sessionId, session)], changed: true };
}

export function restoreGsmImportSession(store: GsmImportStore, sessionId: string): GsmImportDiff | null {
  const session = store.sessions[sessionId];
  if (!session || session.state !== 'deleted') return null;
  const next = copyStore(store);
  const { restoreTo, ...rest } = session;
  next.sessions[sessionId] = { ...rest, state: restoreTo ?? 'pending' };
  return { store: next, add: [statEntry(next, sessionId, session)], subtract: [], changed: true };
}

export function gsmImportViewEntries(store: GsmImportStore): PendingEntry[] {
  return Object.entries(store.sessions)
    .filter(([, session]) => isCounted(session.state))
    .map(([sid, session]) => statEntry(store, sid, session));
}

// local minutes the cached server total cannot contain yet
export function gsmImportMinutesOffServer(store: GsmImportStore, owner: number, cachedAt: number | undefined): number {
  let seconds = 0;
  for (const session of Object.values(store.sessions)) {
    if (session.owner !== null && session.owner !== owner) continue;
    const offServer = session.state === 'pending' || session.state === 'rejected' || session.state === 'failed'
      || (session.state === 'uploaded' && (cachedAt === undefined || (session.uploadedAt ?? 0) > cachedAt));
    if (offServer) seconds += session.seconds;
  }
  return seconds / 60;
}

// a sync session over imported time would count it twice
export function withoutImportOverlaps(days: PlannedDay[], store: GsmImportStore, from: number): PlannedDay[] {
  const spans: Array<[number, number]> = [];
  for (const session of Object.values(store.sessions)) if (session.end > from) spans.push([session.start, session.end]);
  if (!spans.length) return days;
  return days.map(day => ({
    ...day,
    wire: {
      ...day.wire,
      sessions: day.wire.sessions.filter(wire => !overlapsAny(wireSeconds(wire.start_utc), wireSeconds(wire.end_utc), spans)),
    },
  }));
}

export function countGsmImport(store: GsmImportStore): GsmImportCounts {
  const counts: GsmImportCounts = {
    sessions: 0, seconds: 0, pending: 0, uploaded: 0, deleted: 0, serverDeleted: 0, rejected: 0, failed: 0, notJapanese: 0,
    deferredGames: store.deferred.length, uploadStatus: store.uploadStatus,
  };
  for (const session of Object.values(store.sessions)) {
    if (session.state === 'deleted') counts.deleted++;
    else if (session.state === 'server_deleted') counts.serverDeleted++;
    else {
      counts.sessions++;
      counts.seconds += session.seconds;
      counts[session.state]++;
      if (!isJapaneseGsmSession(session.linesScript, session.linesKana)) counts.notJapanese++;
    }
  }
  return counts;
}
