import type { CachedServerSession, JP343UserState, PendingEntry, TrackingSession } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { withStorageLock } from '../storage-lock';
import { loadPendingEntries } from '../pending-entries';
import { tracker } from '../time-tracker';
import { getCustomSitesState, saveCustomSitesState } from './custom-sites';
import { attemptRecovery } from './auth-recovery';

const MAX_CUSTOM_NAMES = 300;
const MAX_RENAME_SYNC_ATTEMPTS = 10;

export interface RenameResult {
  ok: boolean;
  localOnly: boolean;
  pendingServerSync: boolean;
  title?: string;
  error?: string;
}

export interface RenameDeps {
  saveSessionState: (session: TrackingSession | null) => Promise<void>;
}

interface ServerSyncOutcome {
  status: 'anonymous' | 'skipped' | 'success' | 'failed';
  canonicalTitle?: string;
}

const syncChains = new Map<string, Promise<ServerSyncOutcome>>();

export function normalizeCustomTitle(raw: string): string | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  return Array.from(trimmed).slice(0, 200).join('');
}

export async function getCustomSiteName(videoId: string): Promise<string | null> {
  const state = await getCustomSitesState();
  return state.names[videoId]?.title ?? null;
}

function hostnameFromUrl(url: string | undefined): string {
  if (!url) return '';
  try { return new URL(url).hostname; } catch { return ''; }
}

async function loadCachedServerSessions(): Promise<CachedServerSession[]> {
  const res = await browser.storage.local.get(STORAGE_KEYS.CACHED_SERVER_SESSIONS);
  return (res[STORAGE_KEYS.CACHED_SERVER_SESSIONS] as CachedServerSession[] | undefined) ?? [];
}

export async function applyLocalRenamesToSessions(sessions: CachedServerSession[]): Promise<CachedServerSession[]> {
  const state = await getCustomSitesState();
  const names = state.names;
  if (!names || Object.keys(names).length === 0) return sessions;
  return sessions.map(s => {
    if (!s.project_id?.startsWith('ext_generic_')) return s;
    const rec = names[s.project_id.slice('ext_generic_'.length)];
    return rec?.title ? { ...s, title: rec.title } : s;
  });
}

async function patchLocalTitles(projectId: string, title: string): Promise<void> {
  const pending = await loadPendingEntries();
  const patched = pending.map((e: PendingEntry) => e.project_id === projectId ? { ...e, project: title } : e);
  await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: patched });
  const cached = await loadCachedServerSessions();
  if (cached.length > 0) {
    const patchedCache = cached.map(s => s.project_id === projectId ? { ...s, title } : s);
    await browser.storage.local.set({ [STORAGE_KEYS.CACHED_SERVER_SESSIONS]: patchedCache });
  }
}

async function loadUserState(): Promise<JP343UserState | null> {
  const res = await browser.storage.local.get(STORAGE_KEYS.USER);
  return (res[STORAGE_KEYS.USER] as JP343UserState | undefined) ?? null;
}

export async function applyCustomSiteRename(
  videoId: string,
  rawTitle: string,
  deps: RenameDeps,
  opts: { originalLabelHint?: string; hostHint?: string; resetRequested?: boolean } = {}
): Promise<RenameResult> {
  const title = normalizeCustomTitle(rawTitle);
  if (!title) return { ok: false, localOnly: true, pendingServerSync: false, error: 'Name cannot be empty' };
  const projectId = 'ext_generic_' + videoId;

  const upsert = await withStorageLock(async () => {
    const state = await getCustomSitesState();
    const existing = state.names[videoId];
    if (!existing && Object.keys(state.names).length >= MAX_CUSTOM_NAMES) {
      return { rejected: true as const };
    }
    const live = tracker.getCurrentSession();
    const liveMatches = live?.videoId === videoId ? live : null;
    const pending = await loadPendingEntries();
    const pendingMatch = pending.find(e => e.project_id === projectId);
    const cachedMatch = (await loadCachedServerSessions()).find(s => s.project_id === projectId);
    const originalLabel = existing?.originalLabel
      || opts.originalLabelHint?.trim()
      || liveMatches?.title
      || pendingMatch?.project
      || '';
    const host = liveMatches?.customSiteHost
      || hostnameFromUrl(pendingMatch?.url)
      || hostnameFromUrl(cachedMatch?.url)
      || opts.hostHint
      || existing?.host
      || '';
    const revision = crypto.randomUUID();
    state.names[videoId] = {
      title, host, originalLabel,
      updatedAt: Date.now(), revision,
      serverSynced: false, syncAttempts: 0, lastAttemptAt: null,
      ...(opts.resetRequested ? { resetRequested: true } : {})
    };
    await saveCustomSitesState(state);
    await patchLocalTitles(projectId, title);
    // enqueue in lock: keeps sync order
    return { rejected: false as const, revision, outcomePromise: queueServerSync(videoId, title) };
  });

  if (upsert.rejected) {
    return { ok: false, localOnly: true, pendingServerSync: false, error: 'Too many series names' };
  }

  const live = tracker.getCurrentSession();
  if (live?.videoId === videoId && live.title !== title) {
    tracker.updateSessionTitle(title);
    await deps.saveSessionState(tracker.getCurrentSession());
  }

  const outcome = await upsert.outcomePromise;
  const finalTitle = await writeSyncOutcome(videoId, upsert.revision, outcome, deps);
  const synced = outcome.status === 'success';
  return {
    ok: true,
    localOnly: !synced,
    pendingServerSync: !synced && outcome.status !== 'anonymous',
    title: finalTitle ?? title
  };
}

export async function resetCustomSiteName(projectId: string, deps: RenameDeps): Promise<RenameResult> {
  const videoId = projectId.slice('ext_generic_'.length);
  const state = await getCustomSitesState();
  const record = state.names[videoId];
  if (!record) return { ok: true, localOnly: true, pendingServerSync: false };
  if (!record.originalLabel) {
    await withStorageLock(async () => {
      const fresh = await getCustomSitesState();
      delete fresh.names[videoId];
      await saveCustomSitesState(fresh);
    });
    return { ok: true, localOnly: true, pendingServerSync: false, error: 'Original label unknown, name removed on this device only' };
  }
  const result = await applyCustomSiteRename(videoId, record.originalLabel, deps, { resetRequested: true });
  if (result.ok && !result.pendingServerSync) {
    await withStorageLock(async () => {
      const fresh = await getCustomSitesState();
      if (fresh.names[videoId]?.resetRequested) {
        delete fresh.names[videoId];
        await saveCustomSitesState(fresh);
      }
    });
  }
  return result;
}

export async function flushCustomSiteRenames(deps: RenameDeps): Promise<void> {
  const state = await getCustomSitesState();
  for (const [videoId, record] of Object.entries(state.names)) {
    if (record.serverSynced || record.syncAttempts >= MAX_RENAME_SYNC_ATTEMPTS) continue;
    const outcome = await queueServerSync(videoId, record.title);
    await writeSyncOutcome(videoId, record.revision, outcome, deps);
  }
}

function queueServerSync(videoId: string, title: string): Promise<ServerSyncOutcome> {
  const prev = syncChains.get(videoId) ?? Promise.resolve<ServerSyncOutcome>({ status: 'skipped' });
  const run = prev.then(() => syncRenameToServer(videoId, title), () => syncRenameToServer(videoId, title));
  syncChains.set(videoId, run.catch(() => ({ status: 'failed' as const })));
  return run;
}

async function syncRenameToServer(videoId: string, title: string): Promise<ServerSyncOutcome> {
  let userState = await loadUserState();
  if (!userState?.isLoggedIn) return { status: 'anonymous' };
  if (!userState.extApiToken) {
    const rec = await attemptRecovery(userState);
    if (rec.status === 'healed' && rec.userState?.extApiToken) {
      userState = rec.userState;
    } else if (!userState.nonce) {
      return { status: 'skipped' };
    }
  }
  const first = await postRename(userState, videoId, title);
  if (first.status !== 'authfail') return first;
  const rec = await attemptRecovery(userState);
  if (rec.status === 'healed' && rec.userState?.extApiToken) {
    const retry = await postRename(rec.userState, videoId, title);
    return retry.status === 'authfail' ? { status: 'failed' } : retry;
  }
  return { status: 'failed' };
}

async function postRename(
  userState: JP343UserState,
  videoId: string,
  title: string
): Promise<ServerSyncOutcome | { status: 'authfail' }> {
  const ajaxUrl = userState.ajaxUrl || 'https://jp343.com/wp-admin/admin-ajax.php';
  const params = new URLSearchParams();
  params.set('action', 'jp343_extension_rename_project');
  params.set('project_id', 'ext_generic_' + videoId);
  params.set('new_title', title);
  if (userState.extApiToken) params.set('ext_api_token', userState.extApiToken);
  else if (userState.nonce) params.set('nonce', userState.nonce);
  else return { status: 'skipped' };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(ajaxUrl, { method: 'POST', signal: controller.signal, body: params });
    if (response.status === 401 || response.status === 403) return { status: 'authfail' };
    if (!response.ok) return { status: 'failed' };
    const parsed: unknown = await response.json();
    const result = parsed as { success?: boolean; data?: { title?: unknown; message?: unknown } } | null;
    if (result?.success) {
      const canonical = typeof result.data?.title === 'string' ? result.data.title : undefined;
      return { status: 'success', canonicalTitle: canonical };
    }
    const message = String(result?.data?.message ?? result?.data ?? '');
    if (/token|auth|logged/i.test(message)) return { status: 'authfail' };
    return { status: 'failed' };
  } catch {
    return { status: 'failed' };
  } finally {
    clearTimeout(t);
  }
}

async function writeSyncOutcome(
  videoId: string,
  capturedRevision: string,
  outcome: ServerSyncOutcome,
  deps: RenameDeps
): Promise<string | null> {
  if (outcome.status === 'anonymous' || outcome.status === 'skipped') return null;
  const projectId = 'ext_generic_' + videoId;
  const canonical = await withStorageLock(async () => {
    const state = await getCustomSitesState();
    const record = state.names[videoId];
    if (!record || record.revision !== capturedRevision) return null;
    if (outcome.status === 'failed') {
      record.syncAttempts += 1;
      record.lastAttemptAt = Date.now();
      await saveCustomSitesState(state);
      return null;
    }
    record.serverSynced = true;
    record.lastAttemptAt = Date.now();
    let changedTitle: string | null = null;
    if (outcome.canonicalTitle && outcome.canonicalTitle !== record.title) {
      record.title = outcome.canonicalTitle;
      changedTitle = outcome.canonicalTitle;
      await patchLocalTitles(projectId, outcome.canonicalTitle);
    }
    if (record.resetRequested) delete state.names[videoId];
    await saveCustomSitesState(state);
    return changedTitle;
  });
  if (canonical) {
    const live = tracker.getCurrentSession();
    if (live?.videoId === videoId && live.title !== canonical) {
      tracker.updateSessionTitle(canonical);
      await deps.saveSessionState(tracker.getCurrentSession());
    }
  }
  return canonical;
}
