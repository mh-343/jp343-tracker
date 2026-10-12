import type { GsmGame } from './api';
import type { GsmLine, GsmSession } from './rule';
import { gsmWireTimes, sha256Hex } from './rule';

export const MAX_CALL_DAYS = 16;
export const MAX_CALL_SESSIONS = 600;
export const MAX_CALL_GAMES = 2000;
const MIN_SESSION_SECONDS = 60;
const MAX_SESSION_SECONDS = 86400;
const MAX_SESSION_LINES = 1000000;
const MAX_SESSION_CHARS = 1000000;
const GAME_UUID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const SESSION_ID_PATTERN = /^gsm-[0-9a-f]{32}$/;

export interface WireGame {
  uuid: string;
  title: string;
  vndb_id: string | number | null;
  game_names: string[];
  archived: boolean;
}

export interface WireSession {
  session_id: string;
  game_uuid: string;
  start_utc: string;
  end_utc: string;
  duration_seconds: number;
  lines_script: number;
  lines_kana: number;
  // left out when unknown or invalid
  chars?: number;
}

export interface WireDay {
  day_start_utc: string;
  day_end_utc: string;
  sessions: WireSession[];
}

export interface PlannedDay {
  day: string;
  wire: WireDay;
}

// epoch seconds; sync uses from, import uses before
export interface GsmDayWindow {
  from?: number;
  before?: number;
}

export interface DayPlan {
  days: PlannedDay[];
  rejected: number;
  oversized: number;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localMidnight(day: string, offsetDays = 0): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d + offsetDays);
}

export function addDays(day: string, n: number): string {
  return localDayKey(localMidnight(day, n).getTime());
}

export function utcString(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

export function dayRange(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

export function isValidGsmChars(chars: unknown): chars is number {
  return Number.isSafeInteger(chars) && Number(chars) >= 0 && Number(chars) <= MAX_SESSION_CHARS;
}

export function isValidGameUuid(uuid: string): boolean {
  return GAME_UUID_PATTERN.test(uuid);
}

// lines get the game uuid; unknown names get a pseudo uuid
export async function mapGsmGames(lines: GsmLine[], games: GsmGame[]): Promise<{ lines: GsmLine[]; games: WireGame[] }> {
  const byName = new Map<string, string>();
  const valid = new Set<string>();
  const wire: WireGame[] = [];
  for (const game of games) {
    if (!isValidGameUuid(game.uuid) || valid.has(game.uuid)) continue;
    valid.add(game.uuid);
    wire.push({ uuid: game.uuid, title: game.title, vndb_id: game.vndbId, game_names: game.gameNames, archived: game.archived });
    for (const name of game.gameNames) {
      const owner = byName.get(name);
      if (owner === undefined || game.uuid < owner) byName.set(name, game.uuid);
    }
  }
  const pseudo = new Map<string, string>();
  for (const name of new Set(lines.map(line => line.game))) {
    if (byName.has(name)) continue;
    const uuid = 'name-' + (await sha256Hex(name)).slice(0, 16);
    pseudo.set(name, uuid);
    wire.push({ uuid, title: name, vndb_id: null, game_names: [name], archived: false });
  }
  const mapped = lines.map(line => ({ ...line, game: byName.get(line.game) ?? pseudo.get(line.game) ?? line.game }));
  return { lines: mapped, games: wire };
}

function inWindow(startUtc: number, window: GsmDayWindow): boolean {
  return (window.from === undefined || startUtc >= window.from) && (window.before === undefined || startUtc < window.before);
}

function precheckSession(session: WireSession, startUtc: number, endUtc: number, dayStart: number, dayEnd: number,
  window: GsmDayWindow, gameUuids: Set<string>, seen: Set<string>): boolean {
  if (!SESSION_ID_PATTERN.test(session.session_id) || seen.has(session.session_id)) return false;
  seen.add(session.session_id);
  if (!gameUuids.has(session.game_uuid)) return false;
  if (startUtc > endUtc || startUtc < dayStart || startUtc >= dayEnd || !inWindow(startUtc, window)) return false;
  const duration = session.duration_seconds;
  if (!Number.isSafeInteger(duration) || duration < MIN_SESSION_SECONDS || duration > Math.min(MAX_SESSION_SECONDS, endUtc - startUtc)) return false;
  const { lines_script: script, lines_kana: kana } = session;
  return Number.isSafeInteger(script) && Number.isSafeInteger(kana) && kana >= 0 && kana <= script && script <= MAX_SESSION_LINES;
}

// only days with at least one GSM line are planned
export function planGsmDays(sessions: GsmSession[], lines: GsmLine[], days: string[], window: GsmDayWindow, games: WireGame[]): DayPlan {
  const lineDays = new Set(lines.map(line => localDayKey(line.timestamp * 1000)));
  const gameUuids = new Set(games.map(game => game.uuid));
  const byDay = new Map<string, GsmSession[]>();
  for (const session of sessions) {
    const day = localDayKey(session.start * 1000);
    const list = byDay.get(day);
    if (list) list.push(session);
    else byDay.set(day, [session]);
  }
  const seen = new Set<string>();
  const plan: DayPlan = { days: [], rejected: 0, oversized: 0 };
  for (const day of [...new Set(days)].sort()) {
    if (!lineDays.has(day)) continue;
    const dayStart = localMidnight(day).getTime() / 1000;
    const dayEnd = localMidnight(day, 1).getTime() / 1000;
    const wire: WireSession[] = [];
    for (const session of byDay.get(day) ?? []) {
      const times = gsmWireTimes(session);
      if (!inWindow(times.startUtc, window) || times.durationSeconds < MIN_SESSION_SECONDS) continue;
      const entry: WireSession = {
        session_id: session.sessionId, game_uuid: session.game,
        start_utc: utcString(times.startUtc), end_utc: utcString(times.endUtc), duration_seconds: times.durationSeconds,
        lines_script: session.linesScript, lines_kana: session.linesKana,
        ...(isValidGsmChars(session.chars) ? { chars: session.chars } : {}),
      };
      if (precheckSession(entry, times.startUtc, times.endUtc, dayStart, dayEnd, window, gameUuids, seen)) wire.push(entry);
      else plan.rejected++;
    }
    if (wire.length > MAX_CALL_SESSIONS) {
      plan.oversized++;
      continue;
    }
    plan.days.push({ day, wire: { day_start_utc: utcString(dayStart), day_end_utc: utcString(dayEnd), sessions: wire } });
  }
  return plan;
}

export function splitGsmCalls(days: PlannedDay[]): PlannedDay[][] {
  const calls: PlannedDay[][] = [];
  let current: PlannedDay[] = [];
  let sessions = 0;
  for (const day of days) {
    if (current.length && (current.length >= MAX_CALL_DAYS || sessions + day.wire.sessions.length > MAX_CALL_SESSIONS)) {
      calls.push(current);
      current = [];
      sessions = 0;
    }
    current.push(day);
    sessions += day.wire.sessions.length;
  }
  if (current.length) calls.push(current);
  return calls;
}
