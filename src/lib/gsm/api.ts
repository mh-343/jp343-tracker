import { classifyGsmLine, countGsmChars, gsmTextHash } from './classify';
import { localDayKey } from './payload';
import type { GsmLine } from './rule';
import { GSM_ORIGIN } from './state';

const PAGE_SIZE = 5000;
const MAX_PAGES = 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const FIRST_LINE_SEARCH_FROM = '2000-01-01';
const FIRST_LINE_PAGE_SIZE = 50;

export interface GsmGame {
  uuid: string;
  title: string;
  vndbId: string | number | null;
  gameNames: string[];
  archived: boolean;
}

export class GsmReadError extends Error {
  constructor(readonly kind: 'unreachable' | 'unsupported') {
    super(kind);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function getJson(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(GSM_ORIGIN + path, {
      signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
    });
  } catch {
    throw new GsmReadError('unreachable');
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 404) throw new GsmReadError('unsupported');
  if (!response.ok) throw new GsmReadError('unreachable');
  try {
    return await response.json();
  } catch {
    throw new GsmReadError('unsupported');
  }
}

export function parseGsmGames(body: unknown): GsmGame[] | null {
  const games = record(body)?.games;
  if (!Array.isArray(games)) return null;
  const parsed: GsmGame[] = [];
  for (const raw of games) {
    const game = record(raw);
    if (!game || typeof game.id !== 'string' || !game.id || !Array.isArray(game.game_names)) return null;
    const vndb = game.vndb_id;
    parsed.push({
      uuid: game.id,
      title: typeof game.title_original === 'string' ? game.title_original : '',
      vndbId: typeof vndb === 'string' || typeof vndb === 'number' ? vndb : null,
      gameNames: game.game_names.filter((name): name is string => typeof name === 'string' && name !== ''),
      archived: game.archived_at !== null && game.archived_at !== undefined,
    });
  }
  return parsed;
}

// text is dropped after the script check
export function parseGsmLinePage(body: unknown): { lines: GsmLine[]; rows: number; totalPages: number } | null {
  const page = record(body);
  if (!page || !Array.isArray(page.results) || !Number.isSafeInteger(page.total_pages)) return null;
  const lines: GsmLine[] = [];
  for (const raw of page.results) {
    const row = record(raw);
    if (!row || typeof row.id !== 'string' || typeof row.game_name !== 'string') return null;
    if (typeof row.timestamp !== 'number' || !Number.isFinite(row.timestamp)) return null;
    if (!Number.isSafeInteger(row.sentence_length) || Number(row.sentence_length) < 0) return null;
    if (typeof row.sentence !== 'string' && row.sentence !== null) return null;
    if (row.timestamp <= 0) continue;
    const text = row.sentence ?? '';
    const { script, kana } = classifyGsmLine(text);
    lines.push({
      id: row.id, timestamp: row.timestamp, game: row.game_name, length: Number(row.sentence_length), script, kana,
      chars: countGsmChars(text), textHash: gsmTextHash(text),
    });
  }
  return { lines, rows: page.results.length, totalPages: Number(page.total_pages) };
}

export async function fetchGsmGames(): Promise<GsmGame[]> {
  const games = parseGsmGames(await getJson('/api/games-management'));
  if (!games) throw new GsmReadError('unsupported');
  return games;
}

// local dates, both inclusive
export async function fetchGsmLines(fromDay: string, toDay: string): Promise<GsmLine[]> {
  const byId = new Map<string, GsmLine>();
  for (let page = 1, totalPages = 1; page <= totalPages; page++) {
    const query = new URLSearchParams({
      q: '.*', use_regex: 'true', from_date: fromDay, to_date: toDay,
      sort: 'date_asc', page: String(page), page_size: String(PAGE_SIZE),
    });
    const parsed = parseGsmLinePage(await getJson(`/api/search-sentences?${query}`));
    if (!parsed || parsed.totalPages > MAX_PAGES) throw new GsmReadError('unsupported');
    for (const line of parsed.lines) byId.set(line.id, line);
    totalPages = parsed.totalPages;
    if (!parsed.rows) break;
  }
  return [...byId.values()];
}

// local day of the first line; null without lines
export async function fetchGsmFirstLineDay(toDay: string): Promise<string | null> {
  const query = new URLSearchParams({
    q: '.*', use_regex: 'true', from_date: FIRST_LINE_SEARCH_FROM, to_date: toDay,
    sort: 'date_asc', page: '1', page_size: String(FIRST_LINE_PAGE_SIZE),
  });
  const parsed = parseGsmLinePage(await getJson(`/api/search-sentences?${query}`));
  if (!parsed) throw new GsmReadError('unsupported');
  if (!parsed.lines.length) return null;
  return localDayKey(Math.min(...parsed.lines.map(line => line.timestamp)) * 1000);
}
