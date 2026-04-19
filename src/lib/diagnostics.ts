import type { Platform, ExtensionDiagnostics, PlatformHealth, DiagnosticError } from '../types';
import { STORAGE_KEYS, DEFAULT_DIAGNOSTICS, DEFAULT_PLATFORM_HEALTH } from '../types';

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
  if (!diagnostics.platformHealth[platform]) {
    diagnostics.platformHealth[platform] = { ...DEFAULT_PLATFORM_HEALTH };
  }
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

export function buildRemotePayload(diagnostics: ExtensionDiagnostics): RemotePayload {
  const browserInfo = navigator.userAgent.includes('Firefox') ? 'firefox' : 'chrome';
  const errorsByPlatform = aggregateErrorsByPlatform(diagnostics.recentErrors);

  const platforms: RemotePlatformEntry[] = [];
  for (const [platform, health] of Object.entries(diagnostics.platformHealth)) {
    const platformErrors = errorsByPlatform.get(platform);
    const errors: Array<{ code: string; count: number }> = [];
    if (platformErrors) {
      for (const [code, count] of platformErrors) {
        errors.push({ code, count });
      }
    }
    platforms.push({
      platform,
      counters: { ...health },
      errors
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
  const payload = buildRemotePayload(diagnostics);
  if (payload.platforms.length === 0) return false;

  try {
    const response = await fetch(DIAGNOSTICS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) return false;

    const result = await response.json() as { received?: number };
    if (!result.received || result.received <= 0) return false;

    diagnostics.lastReportSent = new Date().toISOString();
    diagnostics.platformHealth = {};
    diagnostics.recentErrors = [];
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
