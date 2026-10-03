import type {
  BlockedChannel,
  WhitelistedChannel,
  ChannelOp,
  ChannelSyncState,
  ChannelOpsResponse,
  JP343UserState,
  ExtensionSettings,
} from '../../types';
import { STORAGE_KEYS } from '../../types';
import { withStorageLock } from '../storage-lock';
import { isChannelInList } from '../youtube-utils';
import { stableUserId } from '../auth-helpers';
import { loadUserState } from '../server-cache';

export function freshChannelSyncState(ownerUserId: number | null): ChannelSyncState {
  return {
    initialized: false,
    ownerUserId,
    serverVersion: 0,
    serverSnapshot: { blocked: [], whitelisted: [] },
    pendingOps: [],
    lastPullAt: null,
  };
}

let logFn: (...args: unknown[]) => void = () => {};
let onSettingsWrittenFn: ((settings: ExtensionSettings) => void) | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let conflictRetries = 0;
const MAX_CONFLICT_RETRIES = 5;
let reconcileRetries = 0;
const MAX_RECONCILE_RETRIES = 3;
const RECONCILE_FRESH_WINDOW_MS = 5 * 60 * 1000;

export function initChannelSyncCallbacks(callbacks: {
  logger: (...args: unknown[]) => void;
  onSettingsWritten: (settings: ExtensionSettings) => void;
}): void {
  logFn = callbacks.logger;
  onSettingsWrittenFn = callbacks.onSettingsWritten;
}

async function loadSyncState(): Promise<ChannelSyncState> {
  const owner = stableUserId(await loadUserState());
  if (owner === null) return freshChannelSyncState(null);
  const result = await browser.storage.local.get(STORAGE_KEYS.CHANNEL_SYNC);
  const stored: ChannelSyncState = { ...freshChannelSyncState(owner), ...(result[STORAGE_KEYS.CHANNEL_SYNC] || {}) };
  if (stored.ownerUserId !== owner) return freshChannelSyncState(owner);
  // older builds marked initialized without a pull
  if (stored.initialized && stored.lastPullAt === null) stored.initialized = false;
  return stored;
}

async function saveSyncState(state: ChannelSyncState): Promise<void> {
  const owner = stableUserId(await loadUserState());
  if (owner === null) return;
  if (state.ownerUserId != null && state.ownerUserId !== owner) return;
  await browser.storage.local.set({
    [STORAGE_KEYS.CHANNEL_SYNC]: { ...state, ownerUserId: owner }
  });
}

function findAliasKeys(
  map: Map<string, { channelId: string; channelUrl?: string | null }>,
  channelId: string,
  channelUrl: string | null
): string[] {
  const keys: string[] = [];
  for (const [key, entry] of map) {
    if (key === channelId || isChannelInList([entry], channelId, channelUrl)) {
      keys.push(key);
    }
  }
  return keys;
}

function applyOps(
  snapshot: { blocked: BlockedChannel[]; whitelisted: WhitelistedChannel[] },
  ops: ChannelOp[]
): { blocked: BlockedChannel[]; whitelisted: WhitelistedChannel[] } {
  const blocked = new Map(snapshot.blocked.map(c => [c.channelId, c]));
  const whitelisted = new Map(snapshot.whitelisted.map(c => [c.channelId, c]));

  for (const op of ops) {
    const blockedAliases = findAliasKeys(blocked, op.channelId, op.channelUrl);
    const whitelistedAliases = findAliasKeys(whitelisted, op.channelId, op.channelUrl);

    switch (op.action) {
      case 'block':
        whitelistedAliases.forEach(k => whitelisted.delete(k));
        blockedAliases.forEach(k => blocked.delete(k));
        blocked.set(op.channelId, {
          channelId: op.channelId,
          channelName: op.channelName,
          channelUrl: op.channelUrl,
          blockedAt: op.timestamp,
        });
        break;
      case 'unblock':
        blocked.delete(op.channelId);
        break;
      case 'whitelist':
        blockedAliases.forEach(k => blocked.delete(k));
        whitelistedAliases.forEach(k => whitelisted.delete(k));
        whitelisted.set(op.channelId, {
          channelId: op.channelId,
          channelName: op.channelName,
          channelUrl: op.channelUrl,
          whitelistedAt: op.timestamp,
        });
        break;
      case 'unwhitelist':
        whitelisted.delete(op.channelId);
        break;
    }
  }

  return {
    blocked: [...blocked.values()],
    whitelisted: [...whitelisted.values()],
  };
}

function opReflected(
  op: ChannelOp,
  snapshot: { blocked: BlockedChannel[]; whitelisted: WhitelistedChannel[] }
): boolean {
  // removals are exact: the server deletes one id
  switch (op.action) {
    case 'block': return isChannelInList(snapshot.blocked, op.channelId, op.channelUrl);
    case 'unblock': return !snapshot.blocked.some(c => c.channelId === op.channelId);
    case 'whitelist': return isChannelInList(snapshot.whitelisted, op.channelId, op.channelUrl);
    case 'unwhitelist': return !snapshot.whitelisted.some(c => c.channelId === op.channelId);
    default: return true;
  }
}

function unreflectedFreshOps(
  flushedOps: ChannelOp[],
  snapshot: { blocked: BlockedChannel[]; whitelisted: WhitelistedChannel[] },
  freshSinceMs: number
): ChannelOp[] {
  const lastPerChannel = new Map<string, ChannelOp>();
  for (const op of flushedOps) lastPerChannel.set(op.channelId, op);
  const pending: ChannelOp[] = [];
  for (const op of lastPerChannel.values()) {
    if (opReflected(op, snapshot)) continue;
    const opTime = Date.parse(op.timestamp);
    if (Number.isFinite(opTime) && opTime >= freshSinceMs) pending.push(op);
  }
  return pending;
}

function deduplicateSnapshot(snapshot: { blocked: BlockedChannel[]; whitelisted: WhitelistedChannel[] }): { blocked: BlockedChannel[]; whitelisted: WhitelistedChannel[] } {
  const dedup = <T extends { channelId: string; channelName: string }>(list: T[]): T[] => {
    const byId = new Map<string, T>();
    const ucNames = new Map<string, string>();

    for (const entry of list) {
      if (!entry.channelId) continue;
      if (entry.channelId.startsWith('UC')) {
        if (!byId.has(entry.channelId)) {
          byId.set(entry.channelId, entry);
          const name = entry.channelName.trim().toLowerCase();
          if (name) ucNames.set(name, entry.channelId);
        }
      }
    }

    for (const entry of list) {
      if (entry.channelId.startsWith('UC')) continue;
      const name = entry.channelName.trim().toLowerCase();
      if (!name || ucNames.has(name)) continue;
      if (!byId.has(name)) byId.set(name, entry);
    }

    return [...byId.values()];
  };
  return { blocked: dedup(snapshot.blocked), whitelisted: dedup(snapshot.whitelisted) };
}

type ChannelLists = { blocked: BlockedChannel[]; whitelisted: WhitelistedChannel[] };

async function writeChannelLists(
  compute: (settings: ExtensionSettings) => ChannelLists,
  expectedOwner: number | null
): Promise<void> {
  const result = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
  const settings: ExtensionSettings = result[STORAGE_KEYS.SETTINGS];
  if (!settings) return;
  if (stableUserId(await loadUserState()) !== expectedOwner) {
    logFn('[JP343] Channel view write discarded: owner changed');
    return;
  }
  const view = compute(settings);
  settings.blockedChannels = view.blocked;
  settings.whitelistedChannels = view.whitelisted;
  await browser.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
  onSettingsWrittenFn?.(settings);
}

async function updateSettingsFromView(state: ChannelSyncState, expectedOwner: number | null): Promise<void> {
  await writeChannelLists(() => applyOps(state.serverSnapshot, state.pendingOps), expectedOwner);
}

// before the first pull the settings lists are the only state
async function applyOpToSettings(op: ChannelOp, expectedOwner: number | null): Promise<void> {
  await writeChannelLists(settings => applyOps({
    blocked: settings.blockedChannels || [],
    whitelisted: settings.whitelistedChannels || [],
  }, [op]), expectedOwner);
}

function seedOpsFromLocal(state: ChannelSyncState, settings: ExtensionSettings): void {
  const timestamp = new Date().toISOString();
  const known = [...state.serverSnapshot.blocked, ...state.serverSnapshot.whitelisted];
  const seed = (local: { channelId: string; channelName: string; channelUrl: string | null }, action: ChannelOp['action']) => {
    if (isChannelInList(known, local.channelId, local.channelUrl)) return;
    if (isChannelInList(state.pendingOps, local.channelId, local.channelUrl)) return;
    state.pendingOps.push({
      opId: crypto.randomUUID(),
      action,
      channelId: local.channelId,
      channelName: local.channelName,
      channelUrl: local.channelUrl,
      timestamp,
    });
  };
  for (const local of settings.blockedChannels || []) seed(local, 'block');
  for (const local of settings.whitelistedChannels || []) seed(local, 'whitelist');
}

async function getUserState(): Promise<JP343UserState | null> {
  const result = await browser.storage.local.get(STORAGE_KEYS.USER);
  const state = result[STORAGE_KEYS.USER];
  if (!state || !state.isLoggedIn || !state.extApiToken) return null;
  return state as JP343UserState;
}

async function callChannelOpsEndpoint(
  userState: JP343UserState,
  baseVersion: number,
  ops: ChannelOp[]
): Promise<ChannelOpsResponse> {
  const ajaxUrl = userState.ajaxUrl || 'https://jp343.com/wp-admin/admin-ajax.php';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(ajaxUrl, {
      method: 'POST',
      signal: controller.signal,
      body: new URLSearchParams({
        action: 'jp343_extension_channel_ops',
        ext_api_token: userState.extApiToken!,
        extension_version: browser.runtime.getManifest().version,
        base_version: String(baseVersion),
        ops: JSON.stringify(ops),
      }),
    });
    return resp.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function getChannelView(state: ChannelSyncState): { blocked: BlockedChannel[]; whitelisted: WhitelistedChannel[] } {
  return applyOps(state.serverSnapshot, state.pendingOps);
}


export async function initChannelSync(): Promise<void> {
  const state = await loadSyncState();
  if (!state.initialized) {
    logFn('[JP343] Channel sync not initialized, will pull on next login');
  } else {
    logFn('[JP343] Channel sync initialized, version:', state.serverVersion, 'pending ops:', state.pendingOps.length);
  }
}

export async function applyChannelOp(
  op: Omit<ChannelOp, 'opId' | 'timestamp'>
): Promise<void> {
  await withStorageLock(async () => {
    const state = await loadSyncState();
    const fullOp: ChannelOp = {
      ...op,
      opId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };

    state.pendingOps.push(fullOp);
    await saveSyncState(state);
    if (state.initialized) {
      await updateSettingsFromView(state, state.ownerUserId ?? null);
      logFn('[JP343] Channel op queued:', fullOp.action, fullOp.channelId);
    } else {
      await applyOpToSettings(fullOp, state.ownerUserId ?? null);
      logFn('[JP343] Channel op applied locally, sync not initialized:', fullOp.action, fullOp.channelId);
    }
  });

  scheduleFlush();
}

export async function pullFromServer(): Promise<void> {
  const userState = await getUserState();
  if (!userState) {
    logFn('[JP343] Channel pull skipped: not logged in');
    return;
  }

  const pullOwner = stableUserId(userState);
  const baseVersion = (await loadSyncState()).serverVersion;
  let result: ChannelOpsResponse;
  try {
    result = await callChannelOpsEndpoint(userState, baseVersion, []);
  } catch (error) {
    logFn('[JP343] Channel pull error:', error);
    return;
  }
  const data = result.data;
  if (!result.success || !data) {
    logFn('[JP343] Channel pull failed:', data?.message);
    return;
  }

  const shouldFlush = await withStorageLock(async () => {
    if (stableUserId(await loadUserState()) !== pullOwner) {
      logFn('[JP343] Channel pull discarded: owner changed');
      return false;
    }
    const state = await loadSyncState();
    if (state.serverVersion !== baseVersion) {
      logFn('[JP343] Channel pull discarded: stale response');
      return false;
    }
    const firstPull = !state.initialized;
    state.serverSnapshot = deduplicateSnapshot({
      blocked: data.blocked || [],
      whitelisted: data.whitelisted || [],
    });
    state.serverVersion = data.version || 0;
    state.initialized = true;
    state.lastPullAt = new Date().toISOString();
    if (firstPull) {
      const settingsResult = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
      const settings = settingsResult[STORAGE_KEYS.SETTINGS] as ExtensionSettings | undefined;
      if (settings) seedOpsFromLocal(state, settings);
    }

    await saveSyncState(state);
    await updateSettingsFromView(state, pullOwner);
    logFn('[JP343] Channel pull complete, version:', state.serverVersion, 'pending ops:', state.pendingOps.length);
    return state.pendingOps.length > 0;
  });
  if (shouldFlush) scheduleFlush();
}

export async function flushOpsToServer(): Promise<void> {
  await withStorageLock(async () => {
    const state = await loadSyncState();
    if (!state.initialized || state.pendingOps.length === 0) return;

    const userState = await getUserState();
    if (!userState) {
      logFn('[JP343] Channel flush skipped: not logged in');
      return;
    }

    const flushedOps = state.pendingOps;
    const flushOwner = stableUserId(userState);
    try {
      const result = await callChannelOpsEndpoint(
        userState,
        state.serverVersion,
        flushedOps
      );

      if (!result.success || !result.data) {
        logFn('[JP343] Channel flush failed:', result.data?.message);
        scheduleAlarmRetry();
        return;
      }
      if (stableUserId(await loadUserState()) !== flushOwner) {
        logFn('[JP343] Channel flush discarded: owner changed');
        return;
      }

      if (result.data.conflict) {
        state.serverSnapshot = deduplicateSnapshot({
          blocked: result.data.blocked || [],
          whitelisted: result.data.whitelisted || [],
        });
        state.serverVersion = result.data.version || 0;
        await saveSyncState(state);
        await updateSettingsFromView(state, flushOwner);
        conflictRetries++;
        reconcileRetries = 0;
        if (conflictRetries >= MAX_CONFLICT_RETRIES) {
          logFn('[JP343] Channel flush conflict limit reached, deferring to alarm');
          conflictRetries = 0;
          scheduleAlarmRetry();
        } else {
          logFn('[JP343] Channel flush conflict, rebasing. Version:', state.serverVersion, 'retry:', conflictRetries);
          scheduleFlush();
        }
        return;
      }

      conflictRetries = 0;
      const newSnapshot = deduplicateSnapshot({
        blocked: result.data.blocked || [],
        whitelisted: result.data.whitelisted || [],
      });
      const pending = unreflectedFreshOps(flushedOps, newSnapshot, Date.now() - RECONCILE_FRESH_WINDOW_MS);
      state.serverSnapshot = newSnapshot;
      state.serverVersion = result.data.version || 0;
      state.pendingOps = pending;
      await saveSyncState(state);
      await updateSettingsFromView(state, flushOwner);
      if (pending.length > 0 && reconcileRetries < MAX_RECONCILE_RETRIES) {
        reconcileRetries++;
        logFn('[JP343] Channel ops not reflected, re-flushing:', pending.length, 'retry:', reconcileRetries);
        scheduleFlush();
      } else {
        if (pending.length > 0) {
          state.pendingOps = [];
          await saveSyncState(state);
          await updateSettingsFromView(state, flushOwner);
          logFn('[JP343] Channel reconcile limit reached, accepting server state');
        }
        reconcileRetries = 0;
        clearAlarmRetry();
        logFn('[JP343] Channel flush success, version:', state.serverVersion);
      }
    } catch (error) {
      logFn('[JP343] Channel flush error:', error);
      scheduleAlarmRetry();
    }
  });
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushOpsToServer().catch(() => {});
  }, 2000);
  // flush recovery if SW dies
  browser.alarms.create('jp343-channel-flush', { delayInMinutes: 0.5 });
}

function scheduleAlarmRetry(): void {
  browser.alarms.create('jp343-channel-flush', { delayInMinutes: 5 });
}

function clearAlarmRetry(): void {
  browser.alarms.clear('jp343-channel-flush');
}

export async function handleChannelFlushAlarm(): Promise<void> {
  await flushOpsToServer();
}

// first-run migration init
export async function migrateToChannelSync(): Promise<void> {
  await withStorageLock(async () => {
    const state = await loadSyncState();
    if (state.initialized) return;

    const settingsResult = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
    const settings: ExtensionSettings | undefined = settingsResult[STORAGE_KEYS.SETTINGS];
    if (!settings) return;

    const userState = await getUserState();
    if (!userState) {
      logFn('[JP343] Channel sync migration skipped: not logged in');
      return;
    }

    const migrateOwner = stableUserId(userState);
    try {
      const result = await callChannelOpsEndpoint(userState, 0, []);
      if (!result.success || !result.data) {
        logFn('[JP343] Channel sync migration: pull failed, deferring');
        return;
      }
      if (stableUserId(await loadUserState()) !== migrateOwner) {
        logFn('[JP343] Channel sync migration discarded: owner changed');
        return;
      }

      state.serverSnapshot = deduplicateSnapshot({
        blocked: result.data.blocked || [],
        whitelisted: result.data.whitelisted || [],
      });
      state.serverVersion = result.data.version || 0;
      state.initialized = true;
      state.lastPullAt = new Date().toISOString();
      seedOpsFromLocal(state, settings);

      await saveSyncState(state);
      await updateSettingsFromView(state, migrateOwner);
      logFn('[JP343] Channel sync migration complete, pending ops:', state.pendingOps.length);

      if (state.pendingOps.length > 0) {
        scheduleFlush();
      }
    } catch (error) {
      logFn('[JP343] Channel sync migration error:', error);
    }
  });
}
