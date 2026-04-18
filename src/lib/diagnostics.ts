import type { Platform, ExtensionDiagnostics, PlatformHealth } from '../types';
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
