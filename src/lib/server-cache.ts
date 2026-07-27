import { STORAGE_KEYS, type CachedServerSession, type JP343UserState, type OwnedServerCache } from '../types';
import { isStableUserId, normalizeAjaxUrl, stableUserId } from './auth-helpers';

const DEFAULT_AJAX_URL = 'https://jp343.com/wp-admin/admin-ajax.php';

export const SERVER_CACHE_SCHEMA_VERSION = 1;

export type ServerStatsValue = Record<string, unknown>;

const STATS_NUMERIC_FIELDS = ['total_seconds', 'today_seconds', 'week_seconds', 'calendar_week_seconds'];

export function isServerStatsValue(value: unknown): value is ServerStatsValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const stats = value as Record<string, unknown>;
  const present = STATS_NUMERIC_FIELDS.filter(field => stats[field] !== undefined);
  if (present.length === 0) return false;
  return present.every(field => typeof stats[field] === 'number' && Number.isFinite(stats[field]));
}

export function isServerSessionsValue(value: unknown): value is CachedServerSession[] {
  if (!Array.isArray(value)) return false;
  return value.every(item => {
    if (typeof item !== 'object' || item === null) return false;
    const row = item as Record<string, unknown>;
    const idOk = typeof row.id === 'number' || typeof row.id === 'string';
    return idOk && typeof row.duration_min === 'number';
  });
}

export function buildOwnedCache<T>(ownerUserId: number, value: T, cachedAt: number): OwnedServerCache<T> {
  return { schemaVersion: SERVER_CACHE_SCHEMA_VERSION, ownerUserId, cachedAt, value };
}

export function parseOwnedCache<T>(
  raw: unknown,
  expectedOwnerId: number,
  isValidValue: (value: unknown) => value is T
): OwnedServerCache<T> | null {
  if (!isStableUserId(expectedOwnerId)) return null;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const envelope = raw as Record<string, unknown>;
  if (envelope.schemaVersion !== SERVER_CACHE_SCHEMA_VERSION) return null;
  if (!isStableUserId(envelope.ownerUserId)) return null;
  if (envelope.ownerUserId !== expectedOwnerId) return null;
  if (typeof envelope.cachedAt !== 'number') return null;
  if (!isValidValue(envelope.value)) return null;
  return {
    schemaVersion: SERVER_CACHE_SCHEMA_VERSION,
    ownerUserId: envelope.ownerUserId,
    cachedAt: envelope.cachedAt,
    value: envelope.value
  };
}

export async function readOwnedServerStats(
  ownerUserId: number | null
): Promise<OwnedServerCache<ServerStatsValue> | null> {
  if (ownerUserId === null) return null;
  const res = await browser.storage.local.get(STORAGE_KEYS.CACHED_SERVER_STATS);
  return parseOwnedCache(res[STORAGE_KEYS.CACHED_SERVER_STATS], ownerUserId, isServerStatsValue);
}

export async function readOwnedServerSessions(
  ownerUserId: number | null
): Promise<OwnedServerCache<CachedServerSession[]> | null> {
  if (ownerUserId === null) return null;
  const res = await browser.storage.local.get(STORAGE_KEYS.CACHED_SERVER_SESSIONS);
  return parseOwnedCache(res[STORAGE_KEYS.CACHED_SERVER_SESSIONS], ownerUserId, isServerSessionsValue);
}

export async function readServerCacheEpoch(): Promise<number> {
  const res = await browser.storage.local.get(STORAGE_KEYS.SERVER_CACHE_EPOCH);
  const value = res[STORAGE_KEYS.SERVER_CACHE_EPOCH];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function buildCacheInvalidationPatch(nextEpoch: number): Record<string, unknown> {
  return {
    [STORAGE_KEYS.CACHED_SERVER_STATS]: null,
    [STORAGE_KEYS.CACHED_SERVER_SESSIONS]: null,
    [STORAGE_KEYS.SERVER_CACHE_EPOCH]: nextEpoch
  };
}

export async function loadUserState(): Promise<JP343UserState | null> {
  const res = await browser.storage.local.get(STORAGE_KEYS.USER);
  return (res[STORAGE_KEYS.USER] as JP343UserState | undefined) ?? null;
}

export interface ServerRequestContext {
  ownerUserId: number;
  epoch: number;
  credentialKind: 'token' | 'nonce';
  credential: string;
  ajaxUrl: string;
}

export async function captureServerRequestContext(): Promise<ServerRequestContext | null> {
  const userState = await loadUserState();
  const ownerUserId = stableUserId(userState);
  if (ownerUserId === null || !userState?.isLoggedIn) return null;
  const epoch = await readServerCacheEpoch();
  if (userState.extApiToken) {
    return {
      ownerUserId,
      epoch,
      credentialKind: 'token',
      credential: userState.extApiToken,
      ajaxUrl: normalizeAjaxUrl(userState.ajaxUrl) ?? DEFAULT_AJAX_URL
    };
  }
  const ajaxUrl = normalizeAjaxUrl(userState.ajaxUrl);
  if (!userState.nonce || ajaxUrl === null) return null;
  return { ownerUserId, epoch, credentialKind: 'nonce', credential: userState.nonce, ajaxUrl };
}

export function requestCredentialsMode(context: ServerRequestContext): 'omit' | 'include' {
  return context.credentialKind === 'token' ? 'omit' : 'include';
}

export function applyAuthParams(params: URLSearchParams, context: ServerRequestContext, actions: {
  token: string;
  nonce: string;
}): void {
  if (context.credentialKind === 'token') {
    params.set('action', actions.token);
    params.set('ext_api_token', context.credential);
    return;
  }
  params.set('action', actions.nonce);
  params.set('nonce', context.credential);
}

export async function isContextStillCurrent(context: ServerRequestContext): Promise<boolean> {
  const userState = await loadUserState();
  if (stableUserId(userState) !== context.ownerUserId) return false;
  return await readServerCacheEpoch() === context.epoch;
}

export async function isCredentialStillCurrent(context: ServerRequestContext): Promise<boolean> {
  const userState = await loadUserState();
  if (stableUserId(userState) !== context.ownerUserId) return false;
  const live = context.credentialKind === 'token' ? userState?.extApiToken : userState?.nonce;
  return live === context.credential;
}

let cacheStartupBarrier: Promise<void> = Promise.resolve();

export function setServerCacheStartupBarrier(barrier: Promise<void>): void {
  cacheStartupBarrier = barrier.catch(() => {});
}

export function awaitServerCacheStartup(): Promise<void> {
  return cacheStartupBarrier;
}
