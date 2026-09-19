import type { Platform, ExtensionDiagnostics, PlatformHealth, DiagnosticError } from '../types';
import { STORAGE_KEYS, DEFAULT_DIAGNOSTICS, DEFAULT_PLATFORM_HEALTH, PLATFORM_ACTIVITY_TYPE } from '../types';
import { acknowledgeSyncCounts, readSyncPending, readSyncQueue, syncDiagnosticsAllowed } from './background/sync-queue';
import type { SyncCounts } from './background/sync-queue';
import { hasSyncIssue } from './sync-policy';

const MAX_RECENT_ERRORS = 50;

export async function loadDiagnostics(): Promise<ExtensionDiagnostics> {
  try {
    const result = await browser.storage.local.get(STORAGE_KEYS.DIAGNOSTICS);
    const stored = result[STORAGE_KEYS.DIAGNOSTICS];
    if (stored && typeof stored === 'object' && stored.schemaVersion === 1) {
      return { ...DEFAULT_DIAGNOSTICS, ...stored };
    }
    return { ...DEFAULT_DIAGNOSTICS };
  } catch {
    return { ...DEFAULT_DIAGNOSTICS };
  }
}

export async function saveDiagnostics(diagnostics: ExtensionDiagnostics): Promise<void> {
  try {
    await browser.storage.local.set({ [STORAGE_KEYS.DIAGNOSTICS]: diagnostics });
  } catch {
    // best-effort, never throw
  }
}

export function ensurePlatformHealth(
  diagnostics: ExtensionDiagnostics,
  platform: Platform
): PlatformHealth {
  diagnostics.platformHealth[platform] = {
    ...DEFAULT_PLATFORM_HEALTH,
    ...diagnostics.platformHealth[platform]
  };
  return diagnostics.platformHealth[platform]!;
}

export function recordPlatformMilestone(
  diagnostics: ExtensionDiagnostics,
  platform: Platform,
  milestone: keyof PlatformHealth
): void {
  const health = ensurePlatformHealth(diagnostics, platform);
  health[milestone]++;
}

export function recordError(
  diagnostics: ExtensionDiagnostics,
  code: string,
  platform?: Platform
): void {
  diagnostics.recentErrors.push({
    code,
    timestamp: new Date().toISOString(),
    platform
  });
  if (diagnostics.recentErrors.length > MAX_RECENT_ERRORS) {
    diagnostics.recentErrors = diagnostics.recentErrors.slice(-MAX_RECENT_ERRORS);
  }
}

export function recordSyncSuccess(diagnostics: ExtensionDiagnostics): void {
  diagnostics.syncHealth.lastSuccess = new Date().toISOString();
  diagnostics.syncHealth.consecutiveFailures = 0;
}

export function recordSyncFailure(diagnostics: ExtensionDiagnostics): void {
  diagnostics.syncHealth.lastFailure = new Date().toISOString();
  diagnostics.syncHealth.consecutiveFailures++;
}

export function recordBackgroundStartup(diagnostics: ExtensionDiagnostics, version: string): void {
  diagnostics.lastBackgroundStartup = new Date().toISOString();
  diagnostics.extensionVersion = version;
  diagnostics.serviceWorkerRestarts++;
}

export interface DiagnosticsExport {
  schemaVersion: 1;
  exportedAt: string;
  extensionVersion: string;
  browser: string;
  lastBackgroundStartup: string | null;
  serviceWorkerRestarts: number;
  platformHealth: Partial<Record<Platform, PlatformHealth>>;
  syncHealth: {
    lastSuccess: string | null;
    lastFailure: string | null;
    consecutiveFailures: number;
  };
  recentErrorCodes: Array<{ code: string; count: number }>;
}

interface RemotePlatformEntry {
  platform: string;
  counters: PlatformHealth;
  errors: Array<{ code: string; count: number }>;
}

interface RemotePayload {
  schemaVersion: 1;
  extensionVersion: string;
  browser: string;
  browserMajor: number;
  platforms: RemotePlatformEntry[];
}

function getBrowserMajor(): number {
  const match = navigator.userAgent.match(/(?:Chrome|Firefox)\/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function aggregateErrorsByPlatform(
  errors: DiagnosticError[]
): Map<string, Map<string, number>> {
  const byPlatform = new Map<string, Map<string, number>>();
  for (const err of errors) {
    const platform = err.platform || 'unknown';
    if (!byPlatform.has(platform)) {
      byPlatform.set(platform, new Map());
    }
    const counts = byPlatform.get(platform)!;
    counts.set(err.code, (counts.get(err.code) || 0) + 1);
  }
  return byPlatform;
}

export function buildRemotePayload(diagnostics: ExtensionDiagnostics, syncErrors: Partial<Record<Platform, Array<{ code: string; count: number }>>> = {}): RemotePayload {
  const browserInfo = navigator.userAgent.includes('Firefox') ? 'firefox' : 'chrome';
  const errorsByPlatform = aggregateErrorsByPlatform(diagnostics.recentErrors);

  const platforms: RemotePlatformEntry[] = [];
  const names = new Set([...Object.keys(diagnostics.platformHealth), ...Object.keys(syncErrors)] as Platform[]);
  for (const platform of names) {
    const health = diagnostics.platformHealth[platform] ?? DEFAULT_PLATFORM_HEALTH;
    const platformErrors = errorsByPlatform.get(platform);
    const errors: Array<{ code: string; count: number }> = [...(syncErrors[platform] ?? [])];
    if (platformErrors) {
      for (const [code, count] of platformErrors) {
        errors.push({ code, count });
      }
    }
    platforms.push({
      platform,
      counters: { ...health },
      errors: errors.slice(0, 20)
    });
  }

  return {
    schemaVersion: 1,
    extensionVersion: diagnostics.extensionVersion,
    browser: browserInfo,
    browserMajor: getBrowserMajor(),
    platforms
  };
}

const DIAGNOSTICS_ENDPOINT = 'https://jp343.com/wp-json/jp343/v1/extension/diagnostics';

export async function sendDiagnosticsReport(diagnostics: ExtensionDiagnostics): Promise<boolean> {
  if (!await syncDiagnosticsAllowed()) {
    await acknowledgeSyncCounts({});
    return false;
  }
  const snapshot = structuredClone(diagnostics);
  const queue = await readSyncQueue();
  const counts: SyncCounts = structuredClone(queue.counts);
  const pending = await readSyncPending();
  const syncErrors: Partial<Record<Platform, Array<{ code: string; count: number }>>> = {};
  for (const [name, metrics] of Object.entries(counts)) {
    syncErrors[name as Platform] = Object.entries(metrics).filter(([, count]) => count > 0).map(([code, count]) => ({ code, count }));
  }
  const issues = pending.filter(hasSyncIssue);
  const user = (await browser.storage.local.get(STORAGE_KEYS.USER))[STORAGE_KEYS.USER] as { isLoggedIn?: boolean } | undefined;
  if (user?.isLoggedIn || issues.length) {
    const generic = syncErrors.generic ?? (syncErrors.generic = []);
    generic.push({ code: 'sync_queue_sample', count: 1 }, { code: 'sync_queue_affected', count: issues.length ? 1 : 0 });
  }
  for (const platform of new Set(issues.map(e => e.platform))) {
    if (!(platform in PLATFORM_ACTIVITY_TYPE)) continue;
    const errors = syncErrors[platform] ?? (syncErrors[platform] = []);
    errors.push({ code: 'sync_retry_pending', count: issues.filter(e => e.platform === platform && e.syncState?.status !== 'blocked').length });
  }
  const payload = buildRemotePayload(snapshot, syncErrors);
  if (payload.platforms.length === 0) return false;

  try {
    if (!await syncDiagnosticsAllowed()) { await acknowledgeSyncCounts({}); return false; }
    const response = await fetch(DIAGNOSTICS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) return false;

    const result = await response.json() as { received?: number };
    if (!result.received || result.received <= 0) return false;

    diagnostics.lastReportSent = new Date().toISOString();
    for (const platform of Object.keys(snapshot.platformHealth) as Platform[]) {
      const current = diagnostics.platformHealth[platform];
      const sent = snapshot.platformHealth[platform];
      if (current && sent) for (const counter of Object.keys(sent) as (keyof PlatformHealth)[]) {
        current[counter] = Math.max(0, current[counter] - sent[counter]);
      }
    }
    const sentErrors = new Map<string, number>();
    for (const error of snapshot.recentErrors) {
      const key = JSON.stringify(error);
      sentErrors.set(key, (sentErrors.get(key) ?? 0) + 1);
    }
    diagnostics.recentErrors = diagnostics.recentErrors.filter(error => {
      const key = JSON.stringify(error);
      const remaining = sentErrors.get(key) ?? 0;
      if (remaining) { sentErrors.set(key, remaining - 1); return false; }
      return true;
    });
    await acknowledgeSyncCounts(counts);
    await saveDiagnostics(diagnostics);
    return true;
  } catch {
    return false;
  }
}

export function buildExportReport(diagnostics: ExtensionDiagnostics): DiagnosticsExport {
  const errorCounts = new Map<string, number>();
  for (const err of diagnostics.recentErrors) {
    errorCounts.set(err.code, (errorCounts.get(err.code) || 0) + 1);
  }
  const recentErrorCodes = Array.from(errorCounts.entries())
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);

  const browserInfo = navigator.userAgent.includes('Firefox') ? 'firefox' : 'chrome';

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    extensionVersion: diagnostics.extensionVersion,
    browser: browserInfo,
    lastBackgroundStartup: diagnostics.lastBackgroundStartup,
    serviceWorkerRestarts: diagnostics.serviceWorkerRestarts,
    platformHealth: diagnostics.platformHealth,
    syncHealth: {
      lastSuccess: diagnostics.syncHealth.lastSuccess,
      lastFailure: diagnostics.syncHealth.lastFailure,
      consecutiveFailures: diagnostics.syncHealth.consecutiveFailures
    },
    recentErrorCodes
  };
}
