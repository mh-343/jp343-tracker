import type { PendingEntry } from '../../types';
import type { PlannedDay } from './payload';
import { localDayKey } from './payload';

const SESSION_ID_PATTERN = /^gsm-[0-9a-f]{32}$/;
const FALLBACK_TITLE = 'GameSentenceMiner';

export type GsmLocalState = 'live' | 'deleted' | 'server_deleted';

export interface GsmLocalSession {
  dbId: string;
  game: string;
  // epoch seconds, floored like the wire
  start: number;
  // missing on sessions stored before import support
  end?: number;
  seconds: number;
  state: GsmLocalState;
}

export interface GsmStatSource {
  game: string;
  start: number;
  seconds: number;
}

export interface GsmLocalStore {
  sessions: Record<string, GsmLocalSession>;
  games: Record<string, string>;
}

export interface GsmLocalContext {
  enabledAt: number;
  dbId: string;
  archived: Set<string>;
  titles: Record<string, string>;
}

export interface GsmStoreDiff<S> {
  store: S;
  add: PendingEntry[];
  subtract: PendingEntry[];
  changed: boolean;
}

export type GsmLocalDiff = GsmStoreDiff<GsmLocalStore>;

export function emptyGsmLocalStore(): GsmLocalStore {
  return { sessions: {}, games: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLocalSession(value: unknown): value is GsmLocalSession {
  if (!isRecord(value)) return false;
  return typeof value.dbId === 'string' && typeof value.game === 'string'
    && Number.isFinite(value.start) && Number.isFinite(value.seconds)
    && (value.end === undefined || Number.isFinite(value.end))
    && (value.state === 'live' || value.state === 'deleted' || value.state === 'server_deleted');
}

export function toGsmLocalStore(raw: unknown): GsmLocalStore {
  const store = emptyGsmLocalStore();
  if (!isRecord(raw)) return store;
  if (isRecord(raw.sessions)) {
    for (const [sid, session] of Object.entries(raw.sessions)) if (isLocalSession(session)) store.sessions[sid] = session;
  }
  if (isRecord(raw.games)) {
    for (const [uuid, title] of Object.entries(raw.games)) if (typeof title === 'string') store.games[uuid] = title;
  }
  return store;
}

export function isGsmSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_PATTERN.test(id);
}

export function wireSeconds(utc: string): number {
  return Date.parse(utc.replace(' ', 'T') + 'Z') / 1000;
}

export function gsmStatEntry(sessionId: string, session: GsmStatSource, title = FALLBACK_TITLE): PendingEntry {
  return {
    id: sessionId,
    date: new Date(session.start * 1000).toISOString(),
    duration_min: session.seconds / 60,
    project: title || FALLBACK_TITLE,
    project_id: 'ext_gsm_local_' + session.game,
    platform: 'gsm',
    source: 'extension',
    url: '',
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
    isPassive: false,
  };
}

function copyStore(store: GsmLocalStore): GsmLocalStore {
  return { sessions: { ...store.sessions }, games: { ...store.games } };
}

function sameSession(a: GsmLocalSession, b: GsmLocalSession): boolean {
  return a.dbId === b.dbId && a.game === b.game && a.start === b.start && a.end === b.end && a.seconds === b.seconds && a.state === b.state;
}

// same rules as the server ledger
export function reconcileLocalDays(store: GsmLocalStore, days: PlannedDay[], ctx: GsmLocalContext): GsmLocalDiff {
  const next = copyStore(store);
  const add: PendingEntry[] = [];
  const subtract: PendingEntry[] = [];
  let changed = false;
  const entry = (sid: string, session: GsmLocalSession): PendingEntry => gsmStatEntry(sid, session, next.games[session.game]);
  const planned = new Set(days.map(day => day.day));
  const liveByDay = new Map<string, string[]>();
  for (const [sid, session] of Object.entries(store.sessions)) {
    if (session.state !== 'live') continue;
    const key = localDayKey(session.start * 1000);
    if (!planned.has(key)) continue;
    const list = liveByDay.get(key);
    if (list) list.push(sid);
    else liveByDay.set(key, [sid]);
  }

  for (const day of days) {
    const computed = new Set<string>();
    for (const wire of day.wire.sessions) {
      const sid = wire.session_id;
      computed.add(sid);
      const title = ctx.titles[wire.game_uuid];
      if (title !== undefined && next.games[wire.game_uuid] !== title) {
        next.games[wire.game_uuid] = title;
        changed = true;
      }
      const old = next.sessions[sid];
      const fresh: GsmLocalSession = {
        dbId: ctx.dbId, game: wire.game_uuid, start: wireSeconds(wire.start_utc), end: wireSeconds(wire.end_utc),
        seconds: wire.duration_seconds, state: old?.state ?? 'live',
      };
      if (old && sameSession(old, fresh)) continue;
      next.sessions[sid] = fresh;
      changed = true;
      if (fresh.state !== 'live') continue;
      if (old && (old.seconds !== fresh.seconds || old.start !== fresh.start)) subtract.push(entry(sid, old));
      if (!old || old.seconds !== fresh.seconds || old.start !== fresh.start) add.push(entry(sid, fresh));
    }
    for (const sid of liveByDay.get(day.day) ?? []) {
      const session = next.sessions[sid];
      if (!session || session.state !== 'live' || computed.has(sid)) continue;
      if (session.dbId !== ctx.dbId || session.start < ctx.enabledAt || ctx.archived.has(session.game)) continue;
      subtract.push(entry(sid, session));
      delete next.sessions[sid];
      changed = true;
    }
  }
  return { store: next, add, subtract, changed };
}

// keptDeleted null: theme without the field
export function applyServerResult(
  store: GsmLocalStore,
  sentIds: string[],
  rejectedIds: Set<string>,
  keptDeleted: Set<string> | null
): GsmLocalDiff {
  const next = copyStore(store);
  const add: PendingEntry[] = [];
  const subtract: PendingEntry[] = [];
  let changed = false;
  if (keptDeleted === null) return { store: next, add, subtract, changed };
  for (const sid of sentIds) {
    const session = next.sessions[sid];
    if (!session) continue;
    if (keptDeleted.has(sid) && session.state === 'live') {
      subtract.push(gsmStatEntry(sid, session, next.games[session.game]));
      next.sessions[sid] = { ...session, state: 'server_deleted' };
      changed = true;
    } else if (!keptDeleted.has(sid) && !rejectedIds.has(sid) && session.state === 'server_deleted') {
      next.sessions[sid] = { ...session, state: 'live' };
      add.push(gsmStatEntry(sid, session, next.games[session.game]));
      changed = true;
    }
  }
  return { store: next, add, subtract, changed };
}

export function setGsmLocalState(store: GsmLocalStore, sessionId: string, from: GsmLocalState, to: GsmLocalState): GsmLocalDiff | null {
  const session = store.sessions[sessionId];
  if (!session || session.state !== from) return null;
  const next = copyStore(store);
  next.sessions[sessionId] = { ...session, state: to };
  const entry = gsmStatEntry(sessionId, session, next.games[session.game]);
  return {
    store: next,
    add: to === 'live' ? [entry] : [],
    subtract: from === 'live' ? [entry] : [],
    changed: true,
  };
}

export function gsmViewEntries(store: GsmLocalStore): PendingEntry[] {
  return Object.entries(store.sessions)
    .filter(([, session]) => session.state === 'live')
    .map(([sid, session]) => gsmStatEntry(sid, session, store.games[session.game]));
}
