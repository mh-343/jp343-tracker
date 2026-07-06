// JLPT index lookup (port of jlpt.mjs query path)
import { kataToHira } from './jscript';

export type JlptIndex = Map<string, number>;

export function buildIndex(obj: Record<string, number>): JlptIndex {
  return new Map(Object.entries(obj));
}

// 0 = unknown
export function lookupLevel(idx: JlptIndex, candidates: string[]): number {
  for (const c of candidates) {
    if (!c) continue;
    const hit = idx.get(c);
    if (hit !== undefined) return hit;
    const h = kataToHira(c);
    if (h !== c) {
      const hh = idx.get(h);
      if (hh !== undefined) return hh;
    }
  }
  return 0;
}
