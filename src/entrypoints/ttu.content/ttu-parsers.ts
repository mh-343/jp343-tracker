import type { ReaderVolumeSnapshot } from '../../types';

const DB_NAME = 'books';
const STORE_NAME = 'statistic';

interface TtuStatisticRow {
  title?: string;
  charactersRead?: number;
  readingTime?: number;
  completedBook?: number;
}

// djb2, ascii-safe id, avoids CJK-title slug collisions
function hashTitle(title: string): string {
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

async function readStatisticRows(): Promise<TtuStatisticRow[]> {
  if (!(await hasBooksDatabase())) return [];
  const db = await openBooksDb();
  try {
    if (!db.objectStoreNames.contains(STORE_NAME)) return [];
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result as TtuStatisticRow[]);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export function aggregateStatisticRows(rows: TtuStatisticRow[]): Record<string, ReaderVolumeSnapshot> {
  interface Agg { minutes: number; chars: number; completed: boolean; }
  const byTitle = new Map<string, Agg>();

  for (const row of rows) {
    if (!row.title) continue;
    const agg = byTitle.get(row.title) ?? { minutes: 0, chars: 0, completed: false };
    agg.minutes += (row.readingTime || 0) / 60;
    agg.chars += row.charactersRead || 0;
    if (row.completedBook) agg.completed = true;
    byTitle.set(row.title, agg);
  }

  const out: Record<string, ReaderVolumeSnapshot> = {};
  for (const [title, agg] of byTitle) {
    out[hashTitle(title)] = {
      effectiveMin: Math.floor(agg.minutes),
      chars: Math.round(agg.chars),
      currentPage: 0,
      seriesTitle: null,
      volumeTitle: title,
      seriesUuid: null,
      completed: agg.completed,
      deleted: false
    };
  }
  return out;
}

export async function buildTtuSnapshot(): Promise<Record<string, ReaderVolumeSnapshot>> {
  const rows = await readStatisticRows();
  return aggregateStatisticRows(rows);
}
