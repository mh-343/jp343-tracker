import type { DirectSyncResult, JP343UserState } from '../../types';
import { buildEntryParams } from '../entry-payload';
import { asRecord, classifySyncResult, protocolFailure, retryAfterTime, SYNC_RETRY_BASE_MS } from '../sync-policy';
import type { SyncOutcome } from '../sync-policy';
import { captureServerRequestContext, isContextStillCurrent, loadUserState, type ServerRequestContext } from '../server-cache';
import type { AuthRecoveryResult } from './auth-recovery';
import { applySyncOutcomes, markBatchUnavailable, prepareSyncQueue, reserveSyncAttempts, releaseSyncAttempts } from './sync-queue';
import type { SyncAttempt } from './sync-queue';

interface EntrySyncDeps {
  recover: (user?: JP343UserState | null) => Promise<AuthRecoveryResult>;
  onAuthenticated?: () => void;
  completedProjects: () => Promise<Set<string>>;
  onSuccess: (channelIds: (string | null)[]) => void;
  onSettled: () => void;
}

interface WireResponse {
  status: number;
  body: unknown;
  unavailable: boolean;
  retryAt: number;
}

const emptyResult = (): DirectSyncResult => ({ attempted: 0, succeeded: 0, failed: 0, noAuth: false, nonceMissing: false });

async function postEntries(context: ServerRequestContext, attempts: SyncAttempt[], single: boolean, completed: Set<string>): Promise<WireResponse> {
  const entries = attempts.map(a => buildEntryParams(a.entry, completed));
  const params = new URLSearchParams({
    action: single ? 'jp343_extension_log_time' : 'jp343_extension_log_time_batch',
    ext_api_token: context.credential,
    ext_version: browser.runtime.getManifest().version,
    ...(single ? entries[0] : { entries: JSON.stringify(entries) })
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), single ? 15_000 : 20_000);
  try {
    const response = await fetch(context.ajaxUrl, { method: 'POST', credentials: 'omit', body: params, signal: controller.signal });
    const text = await response.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: response.status, body, unavailable: text === '0', retryAt: retryAfterTime(response.headers.get('Retry-After'), Date.now()) };
  } finally { clearTimeout(timeout); }
}

function responseOutcome(response: WireResponse): SyncOutcome {
  const classified = classifySyncResult(response.body);
  if (classified.kind === 'auth') return classified;
  if (response.status < 200 || response.status >= 300) {
    return { kind: 'retry', code: `http_${response.status}`, failureKind: 'server' };
  }
  return classified;
}

function batchOutcomes(response: WireResponse, attempts: SyncAttempt[]): Map<string, SyncOutcome> {
  const outcomes = new Map<string, SyncOutcome>();
  const root = asRecord(response.body);
  const data = asRecord(root?.data);
  if (response.status >= 200 && response.status < 300 && root?.success === true && Array.isArray(data?.results)) {
    const matches = new Map<string, unknown[]>();
    for (const result of data.results) {
      const id = asRecord(result)?.session_id;
      if (typeof id === 'string') matches.set(id, [...(matches.get(id) ?? []), result]);
    }
    for (const attempt of attempts) {
      const results = matches.get(attempt.entry.id) ?? [];
      outcomes.set(attempt.entry.id, results.length === 1 ? classifySyncResult(results[0], true) : protocolFailure());
    }
  } else {
    const result = responseOutcome(response);
    const outcome = result.kind === 'blocked' || result.kind === 'success' ? protocolFailure() : result;
    for (const attempt of attempts) outcomes.set(attempt.entry.id, outcome);
  }
  return outcomes;
}

export function createEntrySync(deps: EntrySyncDeps): () => Promise<DirectSyncResult> {
  let running: Promise<DirectSyncResult> | null = null;

  async function run(): Promise<DirectSyncResult> {
    await prepareSyncQueue();
    let user = await loadUserState();
    if (!user?.isLoggedIn) return { ...emptyResult(), noAuth: true };
    if (!user.extApiToken) {
      const recovery = await deps.recover(user);
      user = recovery.userState;
      if (recovery.status !== 'healed' || !user?.extApiToken) return { ...emptyResult(), noAuth: true, nonceMissing: true };
    }
    let context = await captureServerRequestContext();
    if (!context || context.credentialKind !== 'token') return { ...emptyResult(), noAuth: true };
    deps.onAuthenticated?.();
    let reserved = await reserveSyncAttempts(context);
    if (!reserved.attempts.length) return { ...emptyResult(), deferredUntil: reserved.deferredUntil };
    const completed = await deps.completedProjects();
    const result = emptyResult();
    let recovered = false;

    async function request(attempts: SyncAttempt[], single: boolean): Promise<{ outcomes: Map<string, SyncOutcome>; response?: WireResponse }> {
      if (!context || !await isContextStillCurrent(context)) return { outcomes: new Map() };
      try {
        const response = await postEntries(context, attempts, single, completed);
        const outcomes = single
          ? new Map([[attempts[0].entry.id, responseOutcome(response)]])
          : batchOutcomes(response, attempts);
        if ([...outcomes.values()].some(o => o.kind === 'auth')) {
          if (!recovered && await isContextStillCurrent(context)) {
            recovered = true;
            const token = context.credential;
            const recovery = await deps.recover(await loadUserState());
            if (recovery.status === 'healed' && recovery.userState?.extApiToken !== token && await isContextStillCurrent(context)) {
              const refreshed = await captureServerRequestContext();
              if (refreshed?.credentialKind === 'token') {
                context = refreshed;
                return request(attempts, single);
              }
            }
          }
          result.noAuth = true;
        }
        return { outcomes, response };
      } catch {
        return { outcomes: new Map(attempts.map(a => [a.entry.id, { kind: 'retry', code: 'network_error', failureKind: 'network' }])) };
      }
    }

    async function commit(attempts: SyncAttempt[], received: Awaited<ReturnType<typeof request>>): Promise<void> {
      if (!context) return;
      result.attempted += attempts.length;
      const commonFailure = !received.response || received.response.status === 429 || received.response.status >= 500
        || [...received.outcomes.values()].some(o => o.kind === 'retry' && o.code === 'E200');
      const waitUntil = Math.max(received.response?.retryAt ?? 0, commonFailure ? Date.now() + SYNC_RETRY_BASE_MS : 0);
      const applied = await applySyncOutcomes(attempts, received.outcomes, context, waitUntil);
      result.succeeded += applied.succeeded;
      result.failed += applied.failed;
      if (applied.succeeded) deps.onSuccess(attempts.filter(a => received.outcomes.get(a.entry.id)?.kind === 'success').map(a => a.entry.channelId));
    }

    if (!reserved.single) {
      const received = await request(reserved.attempts, false);
      if (received.response?.unavailable && await isContextStillCurrent(context)) {
        await markBatchUnavailable(reserved.attempts, context);
        reserved = await reserveSyncAttempts(context, true);
      } else {
        await commit(reserved.attempts, received);
        return result;
      }
    }
    let dispatched = 0;
    for (const attempt of reserved.attempts) {
      if (!await isContextStillCurrent(context) || result.noAuth) break;
      const received = await request([attempt], true);
      dispatched++;
      await commit([attempt], received);
      if (!received.response || received.response.status === 429 || received.response.status >= 500
          || [...received.outcomes.values()].some(o => o.kind === 'retry' && o.code === 'E200')) break;
    }
    await releaseSyncAttempts(reserved.attempts.slice(dispatched), context);
    return result;
  }

  return () => {
    if (!running) {
      running = Promise.resolve().then(run).finally(() => {
        running = null;
        deps.onSettled();
      });
    }
    return running;
  };
}
