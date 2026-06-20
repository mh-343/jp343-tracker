import type { AnkiStatus } from '../../types';

// AnkiConnect local server
const ANKI_URL = 'http://127.0.0.1:8765';
const PROBE_TIMEOUT_MS = 2500;
const PERMISSION_TIMEOUT_MS = 30000;   // first call: blocking popup
export const PULL_TIMEOUT_MS = 30000;

// revlog 9-tuple
export type Revlog = [number, number, number, number, number, number, number, number, number];

class AnkiError extends Error {}

function isNetworkError(error: unknown): boolean {
  if (error instanceof TypeError) return true;                       // port dead
  if (error instanceof DOMException && error.name === 'AbortError') return true;  // timeout
  return false;
}

async function ankiInvoke<T>(action: string, params: Record<string, unknown> = {}, timeoutMs = PROBE_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let payload: { result: T; error: string | null };
  try {
    const response = await fetch(ANKI_URL, {
      method: 'POST',
      body: JSON.stringify({ action, version: 6, params }),
      signal: controller.signal
    });
    payload = await response.json() as { result: T; error: string | null };
  } finally {
    clearTimeout(timer);
  }
  if (payload.error) throw new AnkiError(payload.error);
  return payload.result;
}

// error-type branch
export async function ensureConnected(): Promise<AnkiStatus> {
  let permission: { permission?: string };
  try {
    permission = await ankiInvoke<{ permission?: string }>('requestPermission', {}, PERMISSION_TIMEOUT_MS);
  } catch (error) {
    return isNetworkError(error) ? 'unreachable' : 'error';
  }
  if (permission?.permission !== 'granted') return 'permission_needed';
  try {
    await ankiInvoke<number>('version');
  } catch (error) {
    if (isNetworkError(error)) return 'unreachable';
    return 'api_key_required';   // webApiKey set
  }
  return 'connected';
}

// per-collection scope; null = unresolved (caller skips)
export async function getActiveProfile(): Promise<string | null> {
  try {
    const name = await ankiInvoke<string>('getActiveProfile');
    if (typeof name !== 'string') return null;
    return name.length > 0 ? name : 'default';   // empty = default
  } catch {
    return null;   // do not guess on error
  }
}

export async function getDeckNames(): Promise<string[]> {
  return ankiInvoke<string[]>('deckNames');
}

// one deck id per call
export async function pullReviews(decks: string[], startId: number, timeoutMs = PULL_TIMEOUT_MS): Promise<Revlog[]> {
  if (decks.length === 0) return [];
  const actions = decks.map(deck => ({ action: 'cardReviews', params: { deck, startID: startId } }));
  const results = await ankiInvoke<unknown[]>('multi', { actions }, timeoutMs);
  const reviews: Revlog[] = [];
  for (const entry of results) {
    for (const row of normalizeMultiEntry(entry)) {
      if (Array.isArray(row) && row.length >= 9) reviews.push(row as Revlog);
    }
  }
  return reviews;
}

export interface MaturitySnapshot { mature: number; young: number; new: number; }

// deck-scoped maturity counts
export async function maturitySnapshot(selectedDecks: string[]): Promise<MaturitySnapshot | null> {
  const scope = selectedDecks.length === 0
    ? ''
    : '(' + selectedDecks.map(d => `deck:"${d}"`).join(' OR ') + ') ';
  const queries = [
    `${scope}prop:ivl>=21 -is:suspended`,
    `${scope}prop:ivl<21 -is:new -is:suspended`,
    `${scope}is:new -is:suspended`
  ];
  try {
    const actions = queries.map(query => ({ action: 'findCards', params: { query } }));
    const results = await ankiInvoke<unknown[]>('multi', { actions }, PULL_TIMEOUT_MS);
    if (!Array.isArray(results) || results.length !== 3) return null;
    const counts = results.map(r => normalizeMultiEntry(r).length);
    return { mature: counts[0], young: counts[1], new: counts[2] };
  } catch {
    return null;
  }
}

function normalizeMultiEntry(entry: unknown): unknown[] {
  if (Array.isArray(entry)) return entry;
  if (entry && typeof entry === 'object' && 'result' in entry) {
    const result = (entry as { result: unknown }).result;
    if (Array.isArray(result)) return result;
  }
  return [];
}
