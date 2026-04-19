import { tracker, generateProjectId } from '../lib/time-tracker';
import { getLocalDateString } from '../lib/format-utils';
import { withStorageLock } from '../lib/storage-lock';
import { isAuthFailure, handleAuthFailure } from '../lib/auth-helpers';
import { loadPendingEntries } from '../lib/pending-entries';
import {
  initBadgeService,
  scheduleStatusBadgeUpdate,
  updateBadge,
} from '../lib/badge-service';
import { createBackgroundMessageHandler } from '../lib/background/message-handler';
import {
  loadDiagnostics,
  saveDiagnostics,
  recordPlatformMilestone,
  recordError,
  recordBackgroundStartup,
  buildExportReport,
  sendDiagnosticsReport
} from '../lib/diagnostics';
import type { DiagnosticsContext } from '../lib/background/diagnostics-context';
import type {
  ExtensionMessage,
  PendingEntry,
  TrackingSession,
  JP343UserState,
  ExtensionSettings,
  ExtensionStats,
  BlockedChannel,
  DirectSyncResult,
  BatchEntryResult,
  BatchSyncResponse,
  SpotifyContentType,
  Platform,
  ExtensionDiagnostics,
  PlatformHealth
} from '../types';
import { DEFAULT_SETTINGS, DEFAULT_STATS, STORAGE_KEYS } from '../types';

export default defineBackground(() => {
  const DEBUG_MODE = import.meta.env.DEV;
  const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};

  log('[JP343] Background Service Worker started');

  let inMemoryDiagnostics: ExtensionDiagnostics | null = null;
  let diagnosticsFlushTimeout: ReturnType<typeof setTimeout> | null = null;
  const DIAGNOSTICS_FLUSH_DELAY_MS = 500;

  async function getOrLoadDiagnostics(): Promise<ExtensionDiagnostics> {
    if (!inMemoryDiagnostics) {
      inMemoryDiagnostics = await loadDiagnostics();
    }
    return inMemoryDiagnostics;
  }

  function scheduleDiagnosticsFlush(): void {
    if (diagnosticsFlushTimeout) {
      clearTimeout(diagnosticsFlushTimeout);
    }
    diagnosticsFlushTimeout = setTimeout(async () => {
      if (inMemoryDiagnostics) {
        await saveDiagnostics(inMemoryDiagnostics);
      }
      diagnosticsFlushTimeout = null;
    }, DIAGNOSTICS_FLUSH_DELAY_MS);
  }

  async function isDiagnosticsAllowed(): Promise<boolean> {
    const settings = await loadSettings();
    if (!settings.diagnosticsEnabled) return false;
    try {
      const perms = await browser.permissions.getAll() as { data_collection?: string[] };
      if (perms.data_collection && !perms.data_collection.includes('technicalAndInteraction')) {
        return false;
      }
    } catch { /* Chrome/older Firefox: no data_collection field, proceed */ }
    return true;
  }

  function recordDiagnosticEvent(code: string, platform?: Platform): void {
    isDiagnosticsAllowed().then(allowed => {
      if (!allowed) return;
      return getOrLoadDiagnostics();
    }).then(diagnostics => {
      if (!diagnostics) return;
      if (platform) {
        const milestoneMap: Record<string, keyof PlatformHealth> = {
          'content_script_loaded': 'contentScriptLoaded',
          'player_found': 'playerFound',
          'player_missing': 'playerMissing',
          'metadata_found': 'metadataFound',
          'metadata_missing': 'metadataMissing',
          'video_play_sent': 'videoPlaySent'
        };
        const milestone = milestoneMap[code];
        if (milestone) {
          recordPlatformMilestone(diagnostics, platform, milestone);
        } else {
          recordError(diagnostics, code, platform);
        }
      } else {
        recordError(diagnostics, code);
      }
      scheduleDiagnosticsFlush();
    }).catch(() => {});
  }

  const diagnosticsContext: DiagnosticsContext = {
    recordDiagnosticEvent,
    getDiagnostics: getOrLoadDiagnostics,
    buildExportReport
  };

  const DIAGNOSTICS_SEND_INTERVAL_MS = 24 * 60 * 60 * 1000;

  async function maybeSendDiagnostics(): Promise<void> {
    try {
      const allowed = await isDiagnosticsAllowed();
      if (!allowed) return;

      const diagnostics = await getOrLoadDiagnostics();
      const lastSent = diagnostics.lastReportSent
        ? new Date(diagnostics.lastReportSent).getTime()
        : 0;

      if (Date.now() - lastSent < DIAGNOSTICS_SEND_INTERVAL_MS) return;

      const hasPlatformData = Object.keys(diagnostics.platformHealth).length > 0;
      if (!hasPlatformData) return;

      const ok = await sendDiagnosticsReport(diagnostics);
      if (ok) {
        inMemoryDiagnostics = await loadDiagnostics();
        log('[JP343] Diagnostics report sent');
      }
    } catch { /* best-effort */ }
  }

  (async () => {
    if (await isDiagnosticsAllowed()) {
      const diagnostics = await getOrLoadDiagnostics();
      const manifest = browser.runtime.getManifest();
      recordBackgroundStartup(diagnostics, manifest.version);
      await saveDiagnostics(diagnostics);
      log('[JP343] Diagnostics initialized, SW restarts:', diagnostics.serviceWorkerRestarts);
      maybeSendDiagnostics();
    }
  })();

  let cachedSettings: ExtensionSettings | null = null;

  async function loadSettings(): Promise<ExtensionSettings> {
    if (cachedSettings) return { ...cachedSettings };
    try {
      const result = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
      cachedSettings = { ...DEFAULT_SETTINGS, ...result[STORAGE_KEYS.SETTINGS] };
      return { ...cachedSettings };
    } catch (error) {
      log('[JP343] Failed to load settings:', error);
      return { ...DEFAULT_SETTINGS };
    }
  }

  async function saveSettings(settings: ExtensionSettings): Promise<void> {
    cachedSettings = { ...settings };
    try {
      await browser.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
    } catch (error) {
      log('[JP343] Failed to save settings:', error);
    }
  }

  let settingsPullComplete = false;
  let settingsLastUpdated = '';
  let settingsLastPullTime = 0;

  async function syncSettingsToServer(settings: ExtensionSettings): Promise<void> {
    if (!settingsPullComplete) return;
    const userState: JP343UserState | null = (
      await browser.storage.local.get(STORAGE_KEYS.USER)
    )[STORAGE_KEYS.USER] ?? null;
    if (!userState?.isLoggedIn || !userState?.extApiToken) return;

    const ajaxUrl = userState.ajaxUrl || 'https://jp343.com/wp-admin/admin-ajax.php';
    try {
      const resp = await fetch(ajaxUrl, {
        method: 'POST',
        body: new URLSearchParams({
          action: 'jp343_extension_push_settings',
          ext_api_token: userState.extApiToken,
          blocked_channels: JSON.stringify(settings.blockedChannels),
          spotify_content_types: JSON.stringify(settings.spotifyContentTypes),
        }),
      });
      const result = await resp.json();
      if (result.success) {
        log('[JP343] Settings pushed to server');
      } else {
        if (isAuthFailure(result)) { await handleAuthFailure(); return; }
        log('[JP343] Settings push failed:', result.data?.message);
      }
    } catch (error) {
      log('[JP343] Settings push error:', error);
    }
  }

  async function pullAndMergeSettingsFromServer(): Promise<void> {
    const userState: JP343UserState | null = (
      await browser.storage.local.get(STORAGE_KEYS.USER)
    )[STORAGE_KEYS.USER] ?? null;
    if (!userState?.isLoggedIn || !userState?.extApiToken) {
      settingsPullComplete = true;
      return;
    }

    const ajaxUrl = userState.ajaxUrl || 'https://jp343.com/wp-admin/admin-ajax.php';
    try {
      const params: Record<string, string> = {
        action: 'jp343_extension_pull_settings',
        ext_api_token: userState.extApiToken,
      };
      if (settingsLastUpdated) params.since = settingsLastUpdated;

      const resp = await fetch(ajaxUrl, {
        method: 'POST',
        body: new URLSearchParams(params),
      });
      const result = await resp.json();
      if (!result.success) {
        if (isAuthFailure(result)) { await handleAuthFailure(); return; }
        log('[JP343] Settings pull failed:', result.data?.message);
        return;
      }

      if (result.data?.changed === false) {
        log('[JP343] Settings unchanged on server');
        settingsPullComplete = true;
        return;
      }

      if (result.data?.updated_at) settingsLastUpdated = result.data.updated_at;

      const serverBlocked: BlockedChannel[] | null = result.data?.blocked_channels ?? null;
      const serverSpotify: SpotifyContentType[] | null = result.data?.spotify_content_types ?? null;

      const settings = await loadSettings();
      let changed = false;

      if (serverBlocked !== null) {
        const localIds = settings.blockedChannels.map(c => c.channelId).sort().join(',');
        const serverIds = serverBlocked.map(c => c.channelId).sort().join(',');
        if (localIds !== serverIds) {
          settings.blockedChannels = serverBlocked;
          changed = true;
        }
      }

      if (serverSpotify !== null) {
        const localStr = [...settings.spotifyContentTypes].sort().join(',');
        const serverStr = [...serverSpotify].sort().join(',');
        if (localStr !== serverStr) {
          settings.spotifyContentTypes = serverSpotify as SpotifyContentType[];
          changed = true;
        }
      }

      if (changed) {
        await saveSettings(settings);
        log('[JP343] Settings merged from server');
      }
      settingsPullComplete = true;
      settingsLastPullTime = Date.now();
    } catch (error) {
      log('[JP343] Settings pull error:', error);
      settingsPullComplete = true;
    }
  }

  async function savePendingEntry(entry: PendingEntry): Promise<void> {
    await withStorageLock(async () => {
      try {
        const pending = await loadPendingEntries();
        if (pending.some(e => e.id === entry.id)) return;

        const settings = await loadSettings();
        if (settings.mergeSameDaySessions) {
          const entryDay = getLocalDateString(new Date(entry.date));
          const mergeTarget = pending.find(e =>
            e.project_id === entry.project_id &&
            e.project === entry.project &&
            getLocalDateString(new Date(e.date)) === entryDay
          );
          if (mergeTarget) {
            mergeTarget.duration_min += entry.duration_min;
            if (!mergeTarget.thumbnail && entry.thumbnail) {
              mergeTarget.thumbnail = entry.thumbnail;
            }
            if (mergeTarget.synced) {
              mergeTarget.synced = false;
              mergeTarget.syncedAt = null;
              mergeTarget.syncAttempts = 0;
              mergeTarget.lastSyncError = null;
              mergeTarget.mergeResync = true;
            }
            await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: pending });
            log('[JP343] Session merged. Total:', mergeTarget.duration_min.toFixed(1), 'min');
            await updateStats(entry);
            return;
          }
        }

        pending.push(entry);
        await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: pending });
        log('[JP343] Entry saved. Pending:', pending.length);
        updateBadge();
        await updateStats(entry);
      } catch (error) {
        log('[JP343] Failed to save entry:', error);
      }
    });
    await triggerSync();
  }

  let syncInProgress = false;

  async function triggerSync(): Promise<void> {
    if (syncInProgress) return;
    try {
      const userState: JP343UserState | null = (
        await browser.storage.local.get(STORAGE_KEYS.USER)
      )[STORAGE_KEYS.USER] ?? null;
      if (!userState?.isLoggedIn || (!userState?.extApiToken && !userState?.nonce)) return;
      syncInProgress = true;
      log('[JP343] Sync started');
      const result = await syncEntriesDirect();
      log('[JP343] Sync result:', result.succeeded, 'synced,', result.failed, 'failed');
    } catch (error) {
      log('[JP343] Sync error:', error);
    } finally {
      syncInProgress = false;
    }
  }

  browser.alarms.create('jp343-auto-sync-retry', { periodInMinutes: 5 });
  browser.alarms.create('jp343-cleanup-synced', { periodInMinutes: 360 });
  browser.alarms.create('jp343-diagnostics-send', { periodInMinutes: 360 });

  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'jp343-auto-sync-retry') {
      await triggerSync();
      await pullAndMergeSettingsFromServer().catch(() => {});
    }
    if (alarm.name === 'jp343-diagnostics-send') {
      maybeSendDiagnostics();
    }
    if (alarm.name === 'jp343-cleanup-synced') {
      await withStorageLock(async () => {
        const pending = await loadPendingEntries();
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const cleaned = pending.filter(e =>
          !e.synced || !e.syncedAt || new Date(e.syncedAt).getTime() > cutoff
        );
        if (cleaned.length < pending.length) {
          await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: cleaned });
          log('[JP343] Cleanup: ' + (pending.length - cleaned.length) + ' old synced entries removed');
        }
      });
    }
  });

  function buildEntryParams(entry: PendingEntry): Record<string, string> {
    return {
      project_id: entry.project_id,
      duration_seconds: String(Math.round(entry.duration_min * 60)),
      source: 'extension',
      session_id: entry.id,
      type: entry.activityType ?? 'watching',
      notes: '',
      project_title: entry.project,
      project_url: entry.url,
      project_thumbnail: entry.thumbnail || '',
      channel_id: entry.channelId || '',
      channel_name: entry.channelName || '',
      channel_url: entry.channelUrl || '',
      video_title: entry.project,
      resource_url: entry.url,
      thumbnail: entry.thumbnail || '',
      platform: entry.platform,
      date: entry.date.replace('T', ' ').replace(/\.\d+Z$/, '').slice(0, 19),
      ...(entry.mergeResync ? { merge_resync: '1' } : {})
    };
  }

  async function syncEntriesDirect(): Promise<DirectSyncResult> {
    const userState: JP343UserState | null = (
      await browser.storage.local.get(STORAGE_KEYS.USER)
    )[STORAGE_KEYS.USER] ?? null;

    if (!userState) {
      return { attempted: 0, succeeded: 0, failed: 0, noAuth: true, nonceMissing: true };
    }
    const ajaxUrl = userState.ajaxUrl || 'https://jp343.com/wp-admin/admin-ajax.php';

    const hasToken = !!userState.extApiToken;
    const hasNonce = !!userState.nonce;
    const hasAuth = userState.isLoggedIn && (hasToken || hasNonce);
    if (!hasAuth) {
      return { attempted: 0, succeeded: 0, failed: 0, noAuth: true, nonceMissing: !hasToken && !hasNonce };
    }

    const pending = await loadPendingEntries();
    const unsynced = pending.filter(e => !e.synced);
    if (unsynced.length === 0) {
      return { attempted: 0, succeeded: 0, failed: 0, noAuth: false, nonceMissing: false };
    }

    let succeeded = 0;
    let failed = 0;

    // Batch sync: send all entries in one request (token auth only)
    if (hasToken) {
      try {
        const batchParams = new URLSearchParams({
          action: 'jp343_extension_log_time_batch',
          ext_api_token: userState.extApiToken!,
          entries: JSON.stringify(unsynced.map(buildEntryParams))
        });
        const response = await fetch(ajaxUrl, {
          method: 'POST',
          credentials: 'include',
          body: batchParams
        });
        const responseText = await response.text();
        log('[JP343] Batch sync response:', response.status, responseText.slice(0, 200));

        // WP returns "0" for unknown actions — fall through to sequential
        if (responseText === '0') {
          log('[JP343] Batch endpoint not available, falling back to sequential');
        } else {
          let batchResult: { success: boolean; data?: BatchSyncResponse & { code?: string } };
          try {
            batchResult = JSON.parse(responseText);
          } catch {
            log('[JP343] Batch response not JSON, falling back to sequential');
            batchResult = { success: false };
          }

          if (batchResult.success && batchResult.data?.results) {
            const resultMap = new Map<string, BatchEntryResult>();
            for (const r of batchResult.data.results) {
              if (r.session_id) resultMap.set(r.session_id, r);
            }
            const unsyncedMap = new Map(unsynced.map(e => [e.id, e]));

            await withStorageLock(async () => {
              const current = await loadPendingEntries();
              const updated = current.map(e => {
                const entryResult = resultMap.get(e.id);
                if (!entryResult) return e;
                const original = unsyncedMap.get(e.id);
                if (original && e.duration_min !== original.duration_min) return e;
                if (entryResult.success) {
                  return { ...e, synced: true, syncedAt: new Date().toISOString(), lastSyncError: null, serverEntryId: entryResult.entry_id ?? null, mergeResync: false };
                }
                return { ...e, syncAttempts: e.syncAttempts + 1, lastSyncError: entryResult.error || 'Server error' };
              });
              await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: updated });
            });

            succeeded = (batchResult.data.synced || 0) + (batchResult.data.duplicates || 0);
            failed = batchResult.data.failed || 0;
            scheduleStatusBadgeUpdate();
            return { attempted: unsynced.length, succeeded, failed, noAuth: false, nonceMissing: false };
          }

          // Auth error from batch endpoint
          if (isAuthFailure(batchResult)) {
            await handleAuthFailure();
            return { attempted: unsynced.length, succeeded: 0, failed: unsynced.length, noAuth: true, nonceMissing: false };
          }

          // Other batch error — fall through to sequential
          log('[JP343] Batch sync failed, falling back to sequential');
        }
      } catch (error) {
        log('[JP343] Batch sync network error, falling back to sequential:', error);
      }
    }

    // Sequential fallback (nonce path or batch failure)
    let authFailed = false;
    for (const entry of unsynced) {
      try {
        const params: Record<string, string> = {
          action: 'jp343_extension_log_time',
          user_id: String(userState.userId || 0),
          ...(hasToken
            ? { ext_api_token: userState.extApiToken! }
            : { nonce: userState.nonce || '' }),
          ...buildEntryParams(entry)
        };

        const response = await fetch(ajaxUrl, {
          method: 'POST',
          credentials: 'include',
          body: new URLSearchParams(params)
        });

        const responseText = await response.text();
        log('[JP343] Sync response for', entry.project, ':', response.status);

        let result: { success: boolean; data?: { code?: string; message?: string; entry_id?: number } };
        try {
          result = JSON.parse(responseText);
        } catch {
          log('[JP343] Sync response is not JSON');
          failed++;
          continue;
        }

        if (result.success) {
          await withStorageLock(async () => {
            const current = await loadPendingEntries();
            const updated = current.map(e => {
              if (e.id !== entry.id) return e;
              if (e.duration_min !== entry.duration_min) return e;
              return { ...e, synced: true, syncedAt: new Date().toISOString(), lastSyncError: null, serverEntryId: result.data?.entry_id ?? null, mergeResync: false };
            });
            await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: updated });
          });
          succeeded++;
          log('[JP343] Direct sync succeeded:', entry.project);
        } else {
          if (isAuthFailure(result)) {
            await handleAuthFailure();
            authFailed = true;
            failed += (unsynced.length - succeeded - failed);
            break;
          }
          await withStorageLock(async () => {
            const current = await loadPendingEntries();
            const updated = current.map(e =>
              e.id === entry.id
                ? { ...e, syncAttempts: e.syncAttempts + 1, lastSyncError: result.data?.message || 'Server error' }
                : e
            );
            await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: updated });
          });
          failed++;
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Network error';
        await withStorageLock(async () => {
          const current = await loadPendingEntries();
          const updated = current.map(e =>
            e.id === entry.id
              ? { ...e, syncAttempts: e.syncAttempts + 1, lastSyncError: errorMsg }
              : e
          );
          await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: updated });
        });
        failed++;
        log('[JP343] Direct sync error:', entry.id, error);
      }
    }

    scheduleStatusBadgeUpdate();
    return { attempted: unsynced.length, succeeded, failed, noAuth: authFailed, nonceMissing: false };
  }

  async function saveSessionState(session: TrackingSession | null): Promise<void> {
    try {
      await browser.storage.local.set({ [STORAGE_KEYS.SESSION]: session });
    } catch (error) {
      log('[JP343] Failed to save session state:', error);
    }
  }

  async function loadStats(): Promise<ExtensionStats> {
    try {
      const result = await browser.storage.local.get(STORAGE_KEYS.STATS);
      return result[STORAGE_KEYS.STATS] || { ...DEFAULT_STATS };
    } catch {
      return { ...DEFAULT_STATS };
    }
  }

  async function fetchAndCacheServerStats(): Promise<void> {
    try {
      const userResult = await browser.storage.local.get(STORAGE_KEYS.USER);
      const userState = userResult[STORAGE_KEYS.USER] as JP343UserState | undefined;
      if (!userState?.isLoggedIn) return;

      const ajaxUrl = userState.ajaxUrl || 'https://jp343.com/wp-admin/admin-ajax.php';
      const params = new URLSearchParams();

      if (userState.extApiToken) {
        params.set('action', 'jp343_extension_get_time_stats');
        params.set('ext_api_token', userState.extApiToken);
      } else if (userState.nonce) {
        params.set('action', 'jp343_get_time_stats');
        params.set('nonce', userState.nonce);
      } else {
        return;
      }

      const response = await fetch(ajaxUrl, { method: 'POST', body: params });
      const result = await response.json();
      if (result.success && result.data) {
        await browser.storage.local.set({ [STORAGE_KEYS.CACHED_SERVER_STATS]: result.data });
      } else if (isAuthFailure(result)) {
        await handleAuthFailure();
      }
    } catch { /* server unreachable */ }
  }

  async function updateStats(entry: PendingEntry): Promise<void> {
    try {
      const stats = await loadStats();
      const entryDate = new Date(entry.date).toISOString().split('T')[0];
      const today = new Date().toISOString().split('T')[0];

      stats.totalMinutes += entry.duration_min;
      stats.dailyMinutes[entryDate] = (stats.dailyMinutes[entryDate] || 0) + entry.duration_min;

      if (stats.lastActiveDate !== today) {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        if (stats.lastActiveDate === yesterdayStr) {
          stats.currentStreak += 1;
        } else if (stats.lastActiveDate !== today) {
          stats.currentStreak = 1;
        }
        stats.lastActiveDate = today;
      }

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 90);
      const cutoffStr = cutoff.toISOString().split('T')[0];
      for (const dateKey of Object.keys(stats.dailyMinutes)) {
        if (dateKey < cutoffStr) {
          delete stats.dailyMinutes[dateKey];
        }
      }

      await browser.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
      log('[JP343] Stats updated: total=' + Math.round(stats.totalMinutes) + 'm, streak=' + stats.currentStreak);
    } catch (error) {
      log('[JP343] Failed to update stats:', error);
    }
  }

  function recalculateStreak(dailyMinutes: Record<string, number>): number {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let streak = 0;
    const checkDate = new Date(today);

    for (let i = 0; i < 365; i++) {
      const dateStr = checkDate.toISOString().split('T')[0];
      if ((dailyMinutes[dateStr] || 0) > 0) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else if (i === 0) {
        checkDate.setDate(checkDate.getDate() - 1);
        continue;
      } else {
        break;
      }
    }
    return streak;
  }

  async function subtractFromStats(entry: PendingEntry): Promise<void> {
    try {
      const stats = await loadStats();
      const entryDate = new Date(entry.date).toISOString().split('T')[0];

      stats.totalMinutes = Math.max(0, stats.totalMinutes - entry.duration_min);
      if (stats.dailyMinutes[entryDate]) {
        stats.dailyMinutes[entryDate] = Math.max(0, stats.dailyMinutes[entryDate] - entry.duration_min);
        if (stats.dailyMinutes[entryDate] <= 0) {
          delete stats.dailyMinutes[entryDate];
        }
      }

      stats.currentStreak = recalculateStreak(stats.dailyMinutes);


      const dates = Object.keys(stats.dailyMinutes).sort();
      stats.lastActiveDate = dates.length > 0 ? dates[dates.length - 1] : '';

      await browser.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
      log('[JP343] Stats after deletion: total=' + Math.round(stats.totalMinutes) + 'm, streak=' + stats.currentStreak);
    } catch (error) {
      log('[JP343] Failed to subtract stats:', error);
    }
  }

  async function ensureFreshSettings(): Promise<void> {
    const pullAge = Date.now() - settingsLastPullTime;
    if (!settingsPullComplete || pullAge > 60000) {
      await pullAndMergeSettingsFromServer().catch(() => {});
    }
  }

  initBadgeService(loadSettings);
  scheduleStatusBadgeUpdate();

  let resolveRecovery: () => void;
  const recoveryReady = new Promise<void>(r => { resolveRecovery = r; });

  const handleMessage = createBackgroundMessageHandler({
    log,
    loadSettings,
    saveSettings,
    ensureFreshSettings,
    syncSettingsToServer,
    savePendingEntry,
    saveSessionState,
    loadStats,
    subtractFromStats,
    syncEntriesDirect,
    pullAndMergeSettingsFromServer,
    fetchAndCacheServerStats,
    recoveryReady,
  }, diagnosticsContext);

  browser.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
    handleMessage(message, sender).then(
      sendResponse,
      () => sendResponse({ success: false, error: 'Internal error' })
    );
    return true;
  });

  const MAX_RESTORE_AGE_MS = 4 * 60 * 60 * 1000;

  const VALID_PLATFORMS = ['youtube', 'netflix', 'crunchyroll', 'primevideo', 'disneyplus', 'cijapanese', 'spotify', 'generic'];
  const MIN_VALID_TIMESTAMP = 1704067200000;

  function isValidSavedSession(session: unknown): session is TrackingSession {
    if (!session || typeof session !== 'object') return false;
    const s = session as Record<string, unknown>;
    return (
      typeof s.title === 'string' &&
      typeof s.url === 'string' &&
      typeof s.startTime === 'number' && s.startTime > MIN_VALID_TIMESTAMP &&
      typeof s.accumulatedMs === 'number' && s.accumulatedMs >= 0 &&
      typeof s.lastUpdate === 'number' && s.lastUpdate > MIN_VALID_TIMESTAMP &&
      typeof s.isActive === 'boolean' &&
      typeof s.isPaused === 'boolean' &&
      typeof s.platform === 'string' && VALID_PLATFORMS.includes(s.platform as string)
    );
  }

  async function recoverSession(): Promise<void> {
    try {
    const result = await browser.storage.local.get(STORAGE_KEYS.SESSION);
    const savedSession = result[STORAGE_KEYS.SESSION];

    if (!savedSession) return;

    if (!isValidSavedSession(savedSession)) {
      log('[JP343] Recovery: Invalid session data, discarding');
      await saveSessionState(null);
      return;
    }

    const sessionAge = Date.now() - savedSession.lastUpdate;

    if (sessionAge < MAX_RESTORE_AGE_MS) {
      if (
        savedSession.platform === 'generic' &&
        savedSession.isActive &&
        !savedSession.isPaused &&
        sessionAge > 0
      ) {
        savedSession.accumulatedMs += sessionAge;
        log('[JP343] Recovery: Manual session gap compensation:', Math.round(sessionAge / 1000), 's');
      }
      tracker.restoreSession(savedSession);
      log('[JP343] Recovery: Session restored (age:', Math.round(sessionAge / 1000), 's)');
      scheduleStatusBadgeUpdate();
      return;
    }

    if (savedSession.accumulatedMs < 60000) {
      log('[JP343] Recovery: Session too short (<1min), discarding');
      await saveSessionState(null);
      return;
    }

    const durationMinutes = savedSession.accumulatedMs / 60000;

    const projectId = generateProjectId(savedSession.platform, savedSession.title, savedSession.videoId);

    const entry: PendingEntry = {
      id: savedSession.id,
      date: new Date(savedSession.startTime).toISOString(),
      duration_min: durationMinutes,
      project: savedSession.title,
      project_id: projectId,
      platform: savedSession.platform,
      source: 'extension',
      url: savedSession.url,
      thumbnail: savedSession.thumbnailUrl,
      synced: false,
      syncedAt: null,
      syncAttempts: 0,
      lastSyncError: null,
      channelId: savedSession.channelId,
      channelName: savedSession.channelName,
      channelUrl: savedSession.channelUrl,
      activityType: savedSession.activityType
    };

    await savePendingEntry(entry);
    await saveSessionState(null);
    log('[JP343] Recovery: Previous session recovered:', entry.project, durationMinutes, 'min');
    } catch (error) {
      log('[JP343] Error during session recovery:', error);
      await saveSessionState(null);
    }
  }

  recoverSession().finally(() => resolveRecovery());
  fetchAndCacheServerStats();

  browser.alarms.create('jp343-check', { periodInMinutes: 5 });

  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'jp343-check') {
      const session = tracker.getCurrentSession();
      if (session) {
        await saveSessionState(session);
        log('[JP343] Periodic save - Session saved:', session.title, Math.round(session.accumulatedMs / 1000), 's');

        if (session.isPaused && (Date.now() - session.lastUpdate) > MAX_RESTORE_AGE_MS) {
          log('[JP343] Stale session detected (>4h paused) - finalizing');
          const entry = tracker.finalizeSession();
          if (entry) {
            await savePendingEntry(entry);
          }
          await saveSessionState(null);
          scheduleStatusBadgeUpdate();
        }
      }

      const pending = await loadPendingEntries();
      log('[JP343] Periodic check - Pending entries:', pending.length);
    }
  });

  browser.tabs.onRemoved.addListener(async (tabId) => {
    const session = tracker.getCurrentSession();
    if (session && session.tabId === tabId) {
      log('[JP343] Tab closed - saving session');
      const entry = tracker.finalizeSession();
      if (entry) {
        await savePendingEntry(entry);
      }
      await saveSessionState(null);
      scheduleStatusBadgeUpdate();
    }
  });

  browser.tabs.onUpdated.addListener(async (tabId, changeInfo, _tab) => {
    if (!changeInfo.url) return;

    const session = tracker.getCurrentSession();
    if (!session || session.tabId !== tabId) return;

    if (session.platform === 'generic') {
      try {
        const sessionDomain = new URL(session.url).hostname;
        const newDomain = new URL(changeInfo.url).hostname;
        if (sessionDomain !== newDomain) {
          log('[JP343] Domain changed - saving manual session');
          const entry = tracker.finalizeSession();
          if (entry) {
            await savePendingEntry(entry);
          }
          await saveSessionState(null);
          scheduleStatusBadgeUpdate();
        } else {
          tracker.updateSessionUrl(changeInfo.url);
          const updatedSession = tracker.getCurrentSession();
          await saveSessionState(updatedSession);
          log('[JP343] Navigation within domain - session continues');
        }
      } catch {
        const entry = tracker.finalizeSession();
        if (entry) {
          await savePendingEntry(entry);
        }
        await saveSessionState(null);
        scheduleStatusBadgeUpdate();
      }
    } else {
      const platformDomains: Record<string, RegExp> = {
        youtube: /youtube\.com/,
        netflix: /netflix\.com/,
        crunchyroll: /crunchyroll\.com/,
        primevideo: /primevideo\.com|amazon\.\w+/,
        disneyplus: /disneyplus\.com/,
        spotify: /open\.spotify\.com/,
      };
      const samePlatform = platformDomains[session.platform]?.test(changeInfo.url);
      if (!samePlatform) {
        log('[JP343] Navigated away from platform - saving session');
        const entry = tracker.finalizeSession();
        if (entry) {
          await savePendingEntry(entry);
        }
        await saveSessionState(null);
        scheduleStatusBadgeUpdate();
      }
    }
  });
});
