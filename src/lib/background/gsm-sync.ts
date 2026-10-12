import type { JP343UserState } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { GSM_LANG_RULE } from '../gsm/classify';
import type { GsmImportCall, GsmImportDayResult, GsmImportOutcome } from '../gsm/import';
import type { WireDay, WireGame } from '../gsm/payload';
import { utcString } from '../gsm/payload';
import { GSM_RULE } from '../gsm/rule';
import { captureServerRequestContext, loadUserState } from '../server-cache';
import type { ServerRequestContext } from '../server-cache';
import { asRecord } from '../sync-policy';
import type { AuthRecoveryResult } from './auth-recovery';

const REQUEST_TIMEOUT_MS = 30_000;
const CALL_GAP_MS = 6_000;

let nextCallAt = 0;

// one 6 s gap for sync and import, slot taken up front
export async function awaitGsmCallGap(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextCallAt);
  nextCallAt = slot + CALL_GAP_MS;
  if (slot > now) await new Promise(resolve => setTimeout(resolve, slot - now));
}

export async function gsmSignedInContext(
  recover: (user?: JP343UserState | null) => Promise<AuthRecoveryResult>
): Promise<ServerRequestContext | null> {
  const stored = await browser.storage.local.get(STORAGE_KEYS.RELOGIN_REQUIRED);
  if (stored[STORAGE_KEYS.RELOGIN_REQUIRED]) return null;
  const user = await loadUserState();
  if (user?.isLoggedIn && !user.extApiToken) await recover(user);
  const context = await captureServerRequestContext();
  return context?.credentialKind === 'token' ? context : null;
}

export interface GsmCall {
  dbId: string;
  enabledAt: string;
  games: WireGame[];
  days: WireDay[];
}

export type GsmCallOutcome =
  | {
      kind: 'ok'; changed: boolean; skipped: number; keptDeleted: Set<string> | null; rejectedIds: Set<string>;
      // by day_start_utc
      lbExcluded: Map<string, number>;
    }
  | { kind: 'auth' }
  | { kind: 'invalid' }
  | { kind: 'retry'; code: string };

function count(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0;
}

export function parseGsmSyncResponse(status: number, text: string): GsmCallOutcome {
  if (text === '0') return { kind: 'retry', code: 'unavailable' };
  let body: unknown;
  try { body = JSON.parse(text); } catch { return { kind: 'retry', code: `http_${status}` }; }
  const root = asRecord(body);
  const data = asRecord(root?.data);
  if (root?.success === true && Array.isArray(data?.days)) {
    let changed = false;
    let skipped = 0;
    let keptDeleted: Set<string> | null = null;
    const rejectedIds = new Set<string>();
    const lbExcluded = new Map<string, number>();
    for (const raw of data.days) {
      const day = asRecord(raw);
      if (!day) continue;
      changed ||= count(day.inserted) + count(day.updated) + count(day.deleted) > 0;
      skipped += count(day.failed) + (Array.isArray(day.rejected) ? day.rejected.length : 0);
      if (typeof day.day_start_utc === 'string' && Number.isSafeInteger(day.lb_excluded) && Number(day.lb_excluded) >= 0) {
        lbExcluded.set(day.day_start_utc, Number(day.lb_excluded));
      }
      if (Array.isArray(day.kept_deleted_ids)) {
        keptDeleted ??= new Set();
        for (const id of day.kept_deleted_ids) if (typeof id === 'string') keptDeleted.add(id);
      }
      if (Array.isArray(day.rejected)) {
        for (const item of day.rejected) {
          const id = asRecord(item)?.session_id;
          if (typeof id === 'string') rejectedIds.add(id);
        }
      }
    }
    return { kind: 'ok', changed, skipped, keptDeleted, rejectedIds, lbExcluded };
  }
  const code = typeof data?.code === 'string' ? data.code : '';
  if (root?.success === false && (code === 'invalid_token' || code === 'E001')) return { kind: 'auth' };
  if (root?.success === false && code === 'E107') return { kind: 'invalid' };
  return { kind: 'retry', code: code || `http_${status}` };
}

function idSet(value: unknown): Set<string> {
  const ids = new Set<string>();
  if (Array.isArray(value)) for (const id of value) if (typeof id === 'string') ids.add(id);
  return ids;
}

export function parseGsmImportResponse(status: number, text: string): GsmImportOutcome {
  if (text === '0') return { kind: 'retry', code: 'unavailable' };
  let body: unknown;
  try { body = JSON.parse(text); } catch { return { kind: 'retry', code: `http_${status}` }; }
  const root = asRecord(body);
  const data = asRecord(root?.data);
  if (root?.success === true && Array.isArray(data?.days)) {
    const days: GsmImportDayResult[] = [];
    for (const raw of data.days) {
      const day = asRecord(raw);
      if (!day || typeof day.day_start_utc !== 'string') continue;
      const rejectedIds = new Set<string>();
      if (Array.isArray(day.rejected)) {
        for (const item of day.rejected) {
          const id = asRecord(item)?.session_id;
          if (typeof id === 'string') rejectedIds.add(id);
        }
      }
      days.push({
        dayStartUtc: day.day_start_utc,
        inserted: count(day.inserted),
        failedIds: idSet(day.failed_ids),
        goneIds: new Set([...idSet(day.kept_deleted_ids), ...idSet(day.overlap_ids)]),
        rejectedIds,
      });
    }
    return { kind: 'ok', days };
  }
  const code = typeof data?.code === 'string' ? data.code : '';
  if (root?.success === false && (code === 'invalid_token' || code === 'E001')) return { kind: 'auth' };
  if (root?.success === false && code === 'E107') return { kind: 'invalid' };
  return { kind: 'retry', code: code || `http_${status}` };
}

async function postGsm<T>(
  context: ServerRequestContext,
  action: string,
  call: GsmCall,
  parse: (status: number, text: string) => T,
  networkError: T
): Promise<T> {
  const params = new URLSearchParams({
    action,
    ext_api_token: context.credential,
    db_id: call.dbId,
    enabled_at: call.enabledAt,
    rule: GSM_RULE,
    lang_rule: GSM_LANG_RULE,
    games: JSON.stringify(call.games),
    days: JSON.stringify(call.days),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(context.ajaxUrl, { method: 'POST', credentials: 'omit', body: params, signal: controller.signal });
    return parse(response.status, await response.text());
  } catch {
    return networkError;
  } finally {
    clearTimeout(timer);
  }
}

export function postGsmSync(context: ServerRequestContext, call: GsmCall): Promise<GsmCallOutcome> {
  return postGsm(context, 'jp343_extension_gsm_sync', call, parseGsmSyncResponse, { kind: 'retry', code: 'network_error' });
}

export function postGsmImport(context: ServerRequestContext, call: GsmImportCall): Promise<GsmImportOutcome> {
  const wire: GsmCall = { dbId: call.dbId, enabledAt: utcString(call.enabledAt), games: call.games, days: call.days };
  return postGsm(context, 'jp343_extension_gsm_import', wire, parseGsmImportResponse, { kind: 'retry', code: 'network_error' });
}
