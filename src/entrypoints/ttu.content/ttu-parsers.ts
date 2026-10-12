import type { ReaderVolumeSnapshot } from '../../types';

const DB_NAME = 'books';
const STORE_NAME = 'statistic';
const DATA_STORE = 'data';
const BOOKMARK_STORE = 'bookmark';

const CONTENT_ID = /^[0-9a-f]{64}$/;

interface TtuStatisticRow {
  title?: string;
  dateKey?: string;
  charactersRead?: number;
  readingTime?: number;
  completedBook?: number;
}

export interface TtuBookmarkRow {
  dataId?: number;
  exploredCharCount?: number;
  progress?: number | string;
}

export interface TtuCharPosition {
  offset: number;
  total: number;
}

// djb2, ascii-safe id, avoids CJK-title slug collisions
export function hashTitle(title: string): string {
  let hash = 5381;
  for (let i = 0; i < title.length; i++) {
    hash = ((hash << 5) + hash + title.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

async function hasBooksDatabase(): Promise<boolean> {
  try {
    if (!indexedDB.databases) return false;
    const dbs = await indexedDB.databases();
    return dbs.some(d => d.name === DB_NAME);
  } catch {
    return false;
  }
}

function openBooksDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
}

function getAllRows<T>(db: IDBDatabase, store: string): Promise<T[]> {
  if (!db.objectStoreNames.contains(store)) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

// key cursor: the book text is never loaded
function readTitlesById(db: IDBDatabase): Promise<Map<number, string>> {
  const titles = new Map<number, string>();
  if (!db.objectStoreNames.contains(DATA_STORE)) return Promise.resolve(titles);
  const store = db.transaction(DATA_STORE, 'readonly').objectStore(DATA_STORE);
  if (!store.indexNames.contains('title')) return Promise.resolve(titles);
  return new Promise((resolve, reject) => {
    const req = store.index('title').openKeyCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(titles); return; }
      if (typeof cursor.key === 'string' && typeof cursor.primaryKey === 'number') titles.set(cursor.primaryKey, cursor.key);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// total from ttsu's own ratio, explored / progress
export function ttuCharPosition(bookmark: TtuBookmarkRow): TtuCharPosition | null {
  const offset = bookmark.exploredCharCount;
  const progress = bookmark.progress;
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return null;
  if (typeof progress !== 'number' || !(progress > 0) || progress > 1) return null;
  const total = Math.round(offset / progress);
  return total >= 1 && offset <= total ? { offset, total } : null;
}

// a title shared by two books gives no position
export function charPositionsByTitle(titles: Map<number, string>, bookmarks: TtuBookmarkRow[]): Map<string, TtuCharPosition> {
  const uses = new Map<string, number>();
  for (const title of titles.values()) uses.set(title, (uses.get(title) ?? 0) + 1);
  const positions = new Map<string, TtuCharPosition>();
  for (const bookmark of bookmarks) {
    const title = bookmark.dataId === undefined ? undefined : titles.get(bookmark.dataId);
    if (!title || uses.get(title) !== 1) continue;
    const position = ttuCharPosition(bookmark);
    if (position) positions.set(title, position);
  }
  return positions;
}

export interface TtuIdContext {
  // old title id -> content id, kept by the extension
  known: Record<string, string>;
  // data.id -> text hash, null without text
  hashes: Map<number, string | null>;
  openDataId: number | null;
}

interface TtuBooks {
  rows: TtuStatisticRow[];
  positions: Map<string, TtuCharPosition>;
  contentIds: Map<string, string>;
}

interface TitleAgg {
  title: string;
  minutes: number;
  chars: number;
  completed: boolean;
  firstDay: string;
  lastDay: string;
}

// the reader route is /b?id=<data.id>
export function openBookId(href: string): number | null {
  try {
    const url = new URL(href);
    if (!url.pathname.endsWith('/b')) return null;
    const id = Number(url.searchParams.get('id'));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

// ttsu syncs elementHtml unchanged across devices
export async function hashBookText(html: string | null): Promise<string | null> {
  if (!html) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function readBookHtml(db: IDBDatabase, dataId: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(DATA_STORE, 'readonly').objectStore(DATA_STORE).get(dataId);
    req.onsuccess = () => {
      const html = (req.result as { elementHtml?: unknown } | undefined)?.elementHtml;
      resolve(typeof html === 'string' && html ? html : null);
    };
    req.onerror = () => reject(req.error);
  });
}

function dataIdsByTitle(titles: Map<number, string>): Map<string, number> {
  const ids = new Map<string, number>();
  const shared = new Set<string>();
  for (const [dataId, title] of titles) {
    if (ids.has(title)) shared.add(title);
    else ids.set(title, dataId);
  }
  for (const title of shared) ids.delete(title);
  return ids;
}

// text read once per book and page; open book rechecked
async function contentIdsByTitle(
  db: IDBDatabase,
  titles: Map<number, string>,
  wanted: Set<string>,
  ctx: TtuIdContext
): Promise<Map<string, string>> {
  const dataIds = dataIdsByTitle(titles);
  const out = new Map<string, string>();
  for (const title of wanted) {
    const known = ctx.known[hashTitle(title)];
    const dataId = dataIds.get(title);
    let id: string | null | undefined;
    if (dataId !== undefined && (!known || dataId === ctx.openDataId)) {
      // an opened cloud book gets its text later
      const retry = dataId === ctx.openDataId && ctx.hashes.get(dataId) === null;
      if (!ctx.hashes.has(dataId) || retry) {
        try {
          ctx.hashes.set(dataId, await hashBookText(await readBookHtml(db, dataId)));
        } catch {
          // next poll tries again
        }
      }
      id = ctx.hashes.get(dataId);
    }
    const resolved = id ?? known;
    if (typeof resolved === 'string' && CONTENT_ID.test(resolved)) out.set(title, resolved);
  }
  return out;
}

async function readTtuBooks(ctx: TtuIdContext): Promise<TtuBooks> {
  if (!(await hasBooksDatabase())) return { rows: [], positions: new Map(), contentIds: new Map() };
  const db = await openBooksDb();
  try {
    const rows = await getAllRows<TtuStatisticRow>(db, STORE_NAME);
    let titles = new Map<number, string>();
    let positions = new Map<string, TtuCharPosition>();
    try {
      titles = await readTitlesById(db);
      positions = charPositionsByTitle(titles, await getAllRows<TtuBookmarkRow>(db, BOOKMARK_STORE));
    } catch {
      positions = new Map();
    }
    const wanted = new Set(rows.map(row => row.title).filter((t): t is string => typeof t === 'string' && t !== ''));
    return { rows, positions, contentIds: await contentIdsByTitle(db, titles, wanted, ctx) };
  } finally {
    db.close();
  }
}

const byDay = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function aggregateStatisticRows(
  rows: TtuStatisticRow[],
  positions: Map<string, TtuCharPosition> = new Map(),
  contentIds: Map<string, string> = new Map()
): Record<string, ReaderVolumeSnapshot> {
  const byTitle = new Map<string, TitleAgg>();

  for (const row of rows) {
    if (!row.title) continue;
    const day = typeof row.dateKey === 'string' ? row.dateKey : '';
    const agg = byTitle.get(row.title) ?? { title: row.title, minutes: 0, chars: 0, completed: false, firstDay: day, lastDay: day };
    agg.minutes += (row.readingTime || 0) / 60;
    agg.chars += row.charactersRead || 0;
    if (row.completedBook) agg.completed = true;
    if (byDay(day, agg.firstDay) < 0) agg.firstDay = day;
    if (byDay(day, agg.lastDay) > 0) agg.lastDay = day;
    byTitle.set(row.title, agg);
  }

  // titles with the same text are one book
  const byId = new Map<string, TitleAgg[]>();
  for (const agg of byTitle.values()) {
    const id = contentIds.get(agg.title) ?? hashTitle(agg.title);
    byId.set(id, [...(byId.get(id) ?? []), agg]);
  }

  const out: Record<string, ReaderVolumeSnapshot> = {};
  for (const [id, aggs] of byId) {
    aggs.sort((a, b) => byDay(a.firstDay, b.firstDay));
    const current = aggs.reduce((a, b) => (byDay(b.lastDay, a.lastDay) >= 0 ? b : a));
    const position = positions.get(current.title);
    out[id] = {
      effectiveMin: aggs.reduce((sum, a) => sum + Math.floor(a.minutes), 0),
      chars: aggs.reduce((sum, a) => sum + Math.round(a.chars), 0),
      currentPage: 0,
      seriesTitle: null,
      volumeTitle: current.title,
      seriesUuid: null,
      completed: aggs.some(a => a.completed),
      deleted: false,
      ...(position ? { readingOffset: position.offset, readingTotal: position.total } : {}),
      ...(CONTENT_ID.test(id) ? { legacyIds: aggs.map(a => hashTitle(a.title)) } : {})
    };
  }
  return out;
}

export async function buildTtuSnapshot(ctx: TtuIdContext): Promise<Record<string, ReaderVolumeSnapshot>> {
  const { rows, positions, contentIds } = await readTtuBooks(ctx);
  return aggregateStatisticRows(rows, positions, contentIds);
}
