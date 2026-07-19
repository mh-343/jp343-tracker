import { tracker, generateProjectId } from '../lib/time-tracker';
import { maybeFireStreakRiskNotification } from '../lib/background/streak-notification';
import { withStorageLock } from '../lib/storage-lock';
import { isAuthFailure } from '../lib/auth-helpers';
import {
  initSettingsSyncCallbacks,
  syncSettingsToServer,
  pullAndMergeSettingsFromServer,
  getSettingsLastPullTime,
} from '../lib/background/settings-sync';
import { loadPendingEntries } from '../lib/pending-entries';
import { migrateHourlyMinutes } from '../lib/background/hourly-stats';
import { initStatsCallbacks, loadStats, updateStats, subtractFromStats } from '../lib/background/stats-managers';
import {
  initBadgeService,
  scheduleStatusBadgeUpdate,
  updateBadge,
} from '../lib/badge-service';
import { createBackgroundMessageHandler } from '../lib/background/message-handler';
import { handleShortcutCommand } from '../lib/background/shortcut-commands';
import { syncAnki } from '../lib/background/anki-sync';
import { initContextMenu } from '../lib/background/context-menu';
import { fetchAndCacheServerSessions } from '../lib/server-sessions';
import { flushCustomSiteRenames } from '../lib/background/custom-site-names';
import { attemptRecovery, clearReloginHint } from '../lib/background/auth-recovery';
import { clearVoteStateCache, retryQueuedVotes } from '../lib/background/difficulty-messages';
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
import {
  initChannelSyncCallbacks,
  applyChannelOp as applyChannelOpSync,
  pullFromServer as pullChannelsFromServer,
  flushOpsToServer as flushChannelOps,
  handleChannelFlushAlarm,
  migrateToChannelSync,
} from '../lib/background/channel-sync';
import { syncReaderRegistration } from '../lib/background/reader-sync';
import { READER_SOURCE_LIST } from '../lib/reader-sources';
import { findMergeTarget, applyMergeUpdate } from '../lib/background/pending-merge';
import { syncCustomSitesRegistration } from '../lib/background/custom-sites';
import { reinjectTrackedTabs } from '../lib/background/reinject';
import { initPermissionListeners, finalizeRevokedCustomSession } from '../lib/background/permission-listeners';
import type {
  ExtensionMessage,
  PendingEntry,
  TrackingSession,
  JP343UserState,
  ExtensionSettings,
  DirectSyncResult,
  BatchEntryResult,
  BatchSyncResponse,
  Platform,
  ExtensionDiagnostics,
  PlatformHealth,
  SavePendingResult
} from '../types';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../types';
import { initErrorReporter, reportError, flushErrors } from '../lib/error-reporter';
import { flushDifficultyContrib } from '../lib/background/difficulty-contrib';

export default defineBackground(() => {
  const DEBUG_MODE = import.meta.env.DEV;
  const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};

  log('[JP343] Background Service Worker started');

  initErrorReporter();
  self.addEventListener('unhandledrejection', (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    const message = reason?.message || String(reason);
    const stack = reason?.stack || '';
    reportError(message, 'background.ts', stack, 'background');
  });

  browser.runtime.setUninstallURL('https://jp343.com/uninstall/');

  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      browser.tabs.create({ url: browser.runtime.getURL('/welcome.html') });
    }
  });

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
          'video_play_sent': 'videoPlaySent',
          'heartbeat_resume': 'heartbeatResume',
          'ad_state_recovered': 'adStateRecovered',
          'session_discarded': 'sessionDiscarded',
          'unflushed_collected': 'unflushedCollected',
          'unflushed_failed': 'unflushedFailed',
          'pause_debounced': 'pauseDebounced',
          'session_id_retry': 'sessionIdRetry'
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

  let cachedSettings: ExtensionSettings | null = null;

  async function fetchAndStoreAvatar(url: string, userId: number): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) return;
      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const dataUrl = `data:${blob.type};base64,${btoa(binary)}`;
      await browser.storage.local.set({
        [STORAGE_KEYS.AVATAR_DATA]: dataUrl,
        [STORAGE_KEYS.AVATAR_USER_ID]: userId
      });
      log('[JP343] Avatar stored as base64');
    } catch {
      log('[JP343] Avatar fetch failed');
    }
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEYS.SETTINGS]) {
      cachedSettings = changes[STORAGE_KEYS.SETTINGS].newValue
        ? { ...changes[STORAGE_KEYS.SETTINGS].newValue }
        : null;
    }
    if (area === 'local' && changes[STORAGE_KEYS.USER]) {
      const oldUser = changes[STORAGE_KEYS.USER].oldValue as JP343UserState | undefined;
      const newUser = changes[STORAGE_KEYS.USER].newValue as JP343UserState | undefined;
      if (oldUser && (oldUser.userId !== newUser?.userId || oldUser.extApiToken !== newUser?.extApiToken)) {
        void clearVoteStateCache();
      }
      const oldUrl = oldUser?.avatarUrlSmall || null;
      const newUrl = newUser?.avatarUrlSmall || null;
      const newUserId = newUser?.userId;
      if (oldUrl !== newUrl && newUrl && newUserId) {
        fetchAndStoreAvatar(newUrl, newUserId);
      }
    }
  });

  async function loadSettings(): Promise<ExtensionSettings> {
    if (cachedSettings) return { ...cachedSettings };
    try {
      const result = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
      const raw = { ...DEFAULT_SETTINGS, ...result[STORAGE_KEYS.SETTINGS] };
      if ((raw as Record<string, unknown>).hideNonJapanese === undefined) {
        const oldMode = (raw as Record<string, unknown>).japaneseContentMode;
        const oldBool = (raw as Record<string, unknown>).requireJapaneseContent;
        raw.hideNonJapanese = oldMode === 'hide' || oldBool === true;
        raw.trackJapaneseOnly = oldMode === 'track-only';
        delete (raw as Record<string, unknown>).requireJapaneseContent;
        delete (raw as Record<string, unknown>).japaneseContentMode;
        await browser.storage.local.set({ [STORAGE_KEYS.SETTINGS]: raw });
        log('[JP343] Migrated to hideNonJapanese/trackJapaneseOnly');
      }
      raw.dayStartHour = Math.max(0, Math.min(6, raw.dayStartHour || 0));

      if (!raw.platformDefaultsMigrated) {
        for (const p of ['twitch', 'nihongojikan', 'asbplayer'] as Platform[]) {
          if (!raw.enabledPlatforms.includes(p)) raw.enabledPlatforms.push(p);
        }
        raw.platformDefaultsMigrated = true;
        await browser.storage.local.set({ [STORAGE_KEYS.SETTINGS]: raw });
        log('[JP343] Enabled default platforms for existing install');
      }

      let migrated = false;

      // Normalize @handle → UC-ID within each list
      for (const list of [raw.blockedChannels, raw.whitelistedChannels] as Array<Array<{ channelId: string; channelName: string; channelUrl?: string | null }>>) {
        const ucByName = new Map<string, string>();
        const ucByUrl = new Map<string, string>();
        for (const c of list) {
          if (c.channelId.startsWith('UC')) {
            ucByName.set(c.channelName, c.channelId);
            if (c.channelUrl) {
              const handleMatch = c.channelUrl.match(/\/@([^/?#]+)/);
              if (handleMatch) ucByUrl.set(`@${handleMatch[1]}`, c.channelId);
            }
          }
        }
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].channelId.startsWith('@')) {
            const ucId = ucByUrl.get(list[i].channelId) || ucByName.get(list[i].channelName);
            if (ucId) {
              list.splice(i, 1);
              migrated = true;
            }
          }
        }
      }

      // Cross-list dedup: same channel in both blocked + whitelisted
      if (raw.blockedChannels.length > 0 && raw.whitelistedChannels.length > 0) {
        type ChannelEntry = { channelId: string; channelName: string; channelUrl?: string | null; blockedAt?: string; whitelistedAt?: string };
        const blockedMap = new Map<string, ChannelEntry>();
        const whitelistedMap = new Map<string, ChannelEntry>();
        for (const c of raw.blockedChannels as ChannelEntry[]) blockedMap.set(c.channelId, c);
        for (const c of raw.whitelistedChannels as ChannelEntry[]) whitelistedMap.set(c.channelId, c);

        // Match @handle to UC-ID via channelUrl
        const handleToUc = new Map<string, string>();
        for (const c of [...raw.blockedChannels, ...raw.whitelistedChannels] as ChannelEntry[]) {
          if (c.channelId.startsWith('UC') && c.channelUrl) {
            const m = c.channelUrl.match(/\/@([^/?#]+)/);
            if (m) handleToUc.set(`@${m[1]}`, c.channelId);
          }
        }

        for (const [handleId, ucId] of handleToUc) {
          const inBlocked = blockedMap.has(handleId) || blockedMap.has(ucId);
          const inWhitelisted = whitelistedMap.has(handleId) || whitelistedMap.has(ucId);
          if (inBlocked && inWhitelisted) {
            const bEntry = blockedMap.get(handleId) || blockedMap.get(ucId);
            const wEntry = whitelistedMap.get(handleId) || whitelistedMap.get(ucId);
            const bTime = bEntry?.blockedAt || '';
            const wTime = wEntry?.whitelistedAt || '';
            // Most recent action wins
            if (wTime > bTime) {
              blockedMap.delete(handleId);
              blockedMap.delete(ucId);
            } else {
              whitelistedMap.delete(handleId);
              whitelistedMap.delete(ucId);
            }
            migrated = true;
          }
        }

        if (migrated) {
          raw.blockedChannels = [...blockedMap.values()];
          raw.whitelistedChannels = [...whitelistedMap.values()];
        }
      }

      if (migrated) {
        await browser.storage.local.set({ [STORAGE_KEYS.SETTINGS]: raw });
        log('[JP343] Deduplicated channel entries (within-list + cross-list)');
      }
      cachedSettings = raw;
      return { ...cachedSettings };
    } catch (error) {
      log('[JP343] Failed to load settings:', error);
      return { ...DEFAULT_SETTINGS };
    }
  }

  async function saveSettings(settings: ExtensionSettings): Promise<void> {
    await withStorageLock(async () => {
      const current = (await browser.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS];
      if (current) {
        settings.blockedChannels = current.blockedChannels ?? [];
        settings.whitelistedChannels = current.whitelistedChannels ?? [];
      }
      cachedSettings = { ...settings };
      try {
        await browser.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
      } catch (error) {
        log('[JP343] Failed to save settings:', error);
      }
    });
  }

  async function onAuthFailure(): Promise<void> {
    log('[JP343] Auth failure, attempting recovery');
    await attemptRecovery();
  }

  async function onAuthSuccess(): Promise<void> {
    await clearReloginHint();
    const result = await browser.storage.local.get(STORAGE_KEYS.AUTH_FAILURE_COUNT);
    if (result[STORAGE_KEYS.AUTH_FAILURE_COUNT]) {
      await browser.storage.local.remove(STORAGE_KEYS.AUTH_FAILURE_COUNT);
    }
  }

  initSettingsSyncCallbacks({ log, loadSettings, saveSettings, pullChannelsFromServer, onAuthFailure, onAuthSuccess });
  initStatsCallbacks({ log, loadSettings });

  (async () => {
    if (await isDiagnosticsAllowed()) {
      const diagnostics = await getOrLoadDiagnostics();
      const manifest = browser.runtime.getManifest();
      recordBackgroundStartup(diagnostics, manifest.version);
      await saveDiagnostics(diagnostics);
      log('[JP343] Diagnostics initialized, SW restarts:', diagnostics.serviceWorkerRestarts);
      maybeSendDiagnostics();
    }
  })().catch(() => {});

  async function savePendingEntry(entry: PendingEntry): Promise<SavePendingResult> {
    const result = await withStorageLock<SavePendingResult>(async () => {
      try {
        const pending = await loadPendingEntries();
        if (pending.some(e => e.id === entry.id)) return 'duplicate';

        const settings = await loadSettings();
        if (settings.mergeSameDaySessions) {
          const dsh = settings.dayStartHour || 0;
          const mergeTarget = findMergeTarget(pending, entry, dsh);
          if (mergeTarget) {
            applyMergeUpdate(mergeTarget, entry);
            await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: pending });
            log('[JP343] Session merged. Total:', mergeTarget.duration_min.toFixed(1), 'min');
            return 'merged';
          }
        }

        pending.push(entry);
        await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: pending });
        log('[JP343] Entry saved. Pending:', pending.length);
        updateBadge();
        return 'saved';
      } catch (error) {
        log('[JP343] Failed to save entry:', error);
        return 'error';
      }
    });
    if (result === 'saved' || result === 'merged') await updateStats(entry);
    await triggerSync();
    return result;
  }

  let syncInProgress = false;

  async function triggerSync(): Promise<void> {
    if (syncInProgress) return;
    try {
      const userState: JP343UserState | null = (
        await browser.storage.local.get(STORAGE_KEYS.USER)
      )[STORAGE_KEYS.USER] ?? null;
      if (!userState?.isLoggedIn) return;
      syncInProgress = true;
      log('[JP343] Sync started');
      const result = await syncEntriesDirect();
      log('[JP343] Sync result:', result.succeeded, 'synced,', result.failed, 'failed');
      fetchAndCacheServerSessions().catch(() => {});
      flushCustomSiteRenames({ saveSessionState }).catch(() => {});
    } catch (error) {
      log('[JP343] Sync error:', error);
    } finally {
      syncInProgress = false;
    }
  }

  browser.alarms.create('jp343-auto-sync-retry', { periodInMinutes: 5 });
  browser.alarms.create('jp343-cleanup-synced', { periodInMinutes: 360 });
  browser.alarms.create('jp343-diagnostics-send', { periodInMinutes: 360 });
  browser.alarms.create('jp343-error-flush', { periodInMinutes: 1 });
  browser.alarms.create('jp343-streak-risk-check', { periodInMinutes: 60 });
  browser.alarms.create('jp343-difficulty-contrib-flush', { periodInMinutes: 720 });

  void syncAnki();

  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'jp343-auto-sync-retry') {
      void syncAnki();
      await triggerSync();
      await pullAndMergeSettingsFromServer().catch(() => {});
      flushChannelOps().catch(() => {});
      void retryQueuedVotes();
    }
    if (alarm.name === 'jp343-channel-flush') {
      handleChannelFlushAlarm().catch(() => {});
    }
    if (alarm.name === 'jp343-diagnostics-send') {
      maybeSendDiagnostics();
    }
    if (alarm.name === 'jp343-error-flush') {
      flushErrors().catch(() => {});
    }
    if (alarm.name === 'jp343-streak-risk-check') {
      maybeFireStreakRiskNotification(loadSettings, loadStats).catch(() => {});
    }
    if (alarm.name === 'jp343-difficulty-contrib-flush') {
      flushDifficultyContrib().catch(() => {});
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

  function buildEntryParams(entry: PendingEntry): Record<string, string> {
    return {
      project_id: entry.project_id,
      duration_seconds: String(Math.round(entry.duration_min * 60)),
      chars: String(Math.round(entry.chars ?? 0)),
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
      ...(entry.mergeResync ? { merge_resync: '1' } : {}),
      ...(entry.readingCurrentPage != null ? { reading_current_page: String(entry.readingCurrentPage) } : {}),
      ...(entry.readingCompleted != null ? { reading_completed: entry.readingCompleted ? '1' : '0' } : {})
    };
  }

  async function syncEntriesDirect(retried = false): Promise<DirectSyncResult> {
    let userState: JP343UserState | null = (
      await browser.storage.local.get(STORAGE_KEYS.USER)
    )[STORAGE_KEYS.USER] ?? null;

    if (!userState?.isLoggedIn) {
      return { attempted: 0, succeeded: 0, failed: 0, noAuth: true, nonceMissing: !userState };
    }

    // R1: never fire log_time without a token. Obtain one first; otherwise queue
    // the entries untouched (no failure mark, no syncAttempts bump, no strike).
    if (!userState.extApiToken) {
      const rec = await attemptRecovery(userState);
      if (rec.status === 'healed' && rec.userState?.extApiToken) {
        userState = rec.userState;
      } else {
        return { attempted: 0, succeeded: 0, failed: 0, noAuth: true, nonceMissing: true };
      }
    }

    const ajaxUrl = userState.ajaxUrl || 'https://jp343.com/wp-admin/admin-ajax.php';
    const extVersion = browser.runtime.getManifest().version;

    const MAX_BATCH_SIZE = 50;
    const MAX_SYNC_ATTEMPTS = 10;

    const pending = await loadPendingEntries();
    const unsynced = pending.filter(e => !e.synced && e.syncAttempts < MAX_SYNC_ATTEMPTS);
    if (unsynced.length === 0) {
      return { attempted: 0, succeeded: 0, failed: 0, noAuth: false, nonceMissing: false };
    }
    const batch = unsynced.slice(0, MAX_BATCH_SIZE);

    let succeeded = 0;
    let failed = 0;

    // R3: token held but rejected (site reset the token, or cookie expired).
    // Heal via nonce_refresh and retry once with a rotated token; otherwise queue
    // the batch (no failure mark, no strike). Cookie expiry sets the reconnect hint
    // inside attemptRecovery and never wipes credentials.
    const handleTokenRejected = async (): Promise<DirectSyncResult> => {
      const previousToken = userState!.extApiToken;
      const rec = await attemptRecovery(userState);
      if (
        rec.status === 'healed' &&
        rec.userState?.extApiToken &&
        rec.userState.extApiToken !== previousToken &&
        !retried
      ) {
        return syncEntriesDirect(true);
      }
      return { attempted: batch.length, succeeded, failed: batch.length - succeeded, noAuth: true, nonceMissing: false };
    };

    // Batch sync: send all entries in one request (token auth)
    try {
      const batchParams = new URLSearchParams({
        action: 'jp343_extension_log_time_batch',
        ext_api_token: userState.extApiToken!,
        ext_version: extVersion,
        entries: JSON.stringify(batch.map(buildEntryParams))
      });
      const controller = new AbortController();
      const batchTimeout = setTimeout(() => controller.abort(), 20000);
      let response: Response;
      try {
        response = await fetch(ajaxUrl, {
          method: 'POST',
          credentials: 'include',
          signal: controller.signal,
          body: batchParams
        });
      } finally {
        clearTimeout(batchTimeout);
      }
      if (!response.ok) {
        log('[JP343] Batch sync HTTP error', response.status, ', falling back to sequential');
        throw new Error(`HTTP ${response.status}`);
      }
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
          const unsyncedMap = new Map(batch.map(e => [e.id, e]));

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
          await onAuthSuccess();
          scheduleStatusBadgeUpdate();
          void retryQueuedVotes(batch.filter(e => resultMap.get(e.id)?.success).map(e => e.channelId));
          return { attempted: batch.length, succeeded, failed, noAuth: false, nonceMissing: false };
        }

        if (isAuthFailure(batchResult)) {
          return handleTokenRejected();
        }

        // Other batch error — fall through to sequential
        log('[JP343] Batch sync failed, falling back to sequential');
      }
    } catch (error) {
      log('[JP343] Batch sync network error, falling back to sequential:', error);
    }

    // Sequential fallback (batch unavailable or failed)
    for (const entry of batch) {
      try {
        const params: Record<string, string> = {
          action: 'jp343_extension_log_time',
          user_id: String(userState.userId || 0),
          ext_api_token: userState.extApiToken!,
          ext_version: extVersion,
          ...buildEntryParams(entry)
        };

        const controller = new AbortController();
        const seqTimeout = setTimeout(() => controller.abort(), 15000);
        let response: Response;
        try {
          response = await fetch(ajaxUrl, {
            method: 'POST',
            credentials: 'include',
            signal: controller.signal,
            body: new URLSearchParams(params)
          });
        } finally {
          clearTimeout(seqTimeout);
        }
        if (!response.ok) {
          log('[JP343] Sync HTTP error', response.status, 'for', entry.project);
          failed++;
          continue;
        }

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
          await onAuthSuccess();
          void retryQueuedVotes([entry.channelId]);
          log('[JP343] Direct sync succeeded:', entry.project);
        } else {
          if (isAuthFailure(result)) {
            return handleTokenRejected();
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
    return { attempted: batch.length, succeeded, failed, noAuth: false, nonceMissing: false };
  }

  async function saveSessionState(session: TrackingSession | null): Promise<void> {
    try {
      await browser.storage.local.set({ [STORAGE_KEYS.SESSION]: session });
    } catch (error) {
      log('[JP343] Failed to save session state:', error);
    }
    updateTrackingMenu();
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

      const controller = new AbortController();
      const statsTimeout = setTimeout(() => controller.abort(), 10000);
      let response: Response;
      try {
        response = await fetch(ajaxUrl, { method: 'POST', signal: controller.signal, body: params });
      } finally {
        clearTimeout(statsTimeout);
      }
      if (!response.ok) return;
      const result = await response.json();
      if (result.success && result.data) {
        await browser.storage.local.set({ [STORAGE_KEYS.CACHED_SERVER_STATS]: { ...result.data, cachedAt: Date.now() } });
        await onAuthSuccess();
      } else if (isAuthFailure(result, !!userState.extApiToken)) {
        await onAuthFailure();
      }
    } catch { /* server unreachable */ }
  }

  async function ensureFreshSettings(): Promise<void> {
    const pullAge = Date.now() - await getSettingsLastPullTime();
    if (pullAge > 60000) {
      await pullAndMergeSettingsFromServer().catch(() => {});
    }
  }

  initBadgeService(loadSettings);
  scheduleStatusBadgeUpdate();

  let resolveRecovery: () => void;
  const recoveryReady = new Promise<void>(r => { resolveRecovery = r; });
  recoverSession().finally(() => resolveRecovery());

  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason !== 'update') return;
    // Resume tracking in open tabs.
    return recoveryReady.then(() => reinjectTrackedTabs(log));
  });

  initPermissionListeners({ log, savePendingEntry, saveSessionState });

  let lastSkippedChannel: { channelId: string; channelName: string; channelUrl: string | null } | null = null;

  initChannelSyncCallbacks({
    logger: log,
    onSettingsWritten: (settings) => { cachedSettings = { ...settings }; },
  });

  const handleMessage = createBackgroundMessageHandler({
    log,
    loadSettings,
    saveSettings,
    ensureFreshSettings,
    syncSettingsToServer,
    applyChannelOp: applyChannelOpSync,
    savePendingEntry,
    saveSessionState,
    loadStats,
    subtractFromStats,
    syncEntriesDirect,
    pullAndMergeSettingsFromServer,
    fetchAndCacheServerStats,
    recoveryReady,
    setLastSkippedChannel: (info) => { lastSkippedChannel = info; },
    getLastSkippedChannel: () => lastSkippedChannel,
    fetchAndStoreAvatar,
    pullChannelsFromServer,
    finalizeRevokedCustomOrigins: (origins: string[]) =>
      finalizeRevokedCustomSession(origins, { savePendingEntry, saveSessionState }),
  }, diagnosticsContext);

  browser.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
    handleMessage(message, sender).then(
      sendResponse,
      () => sendResponse({ success: false, error: 'Internal error' })
    );
    return true;
  });

  if (browser.commands?.onCommand) {
    browser.commands.onCommand.addListener((command: string) => {
      handleShortcutCommand(command, handleMessage);
    });
  }

  const updateTrackingMenu = initContextMenu({
    recoveryReady,
    saveSessionState,
    savePendingEntry
  });

  const MAX_RESTORE_AGE_MS = 4 * 60 * 60 * 1000;

  const VALID_PLATFORMS = ['youtube', 'netflix', 'crunchyroll', 'primevideo', 'disneyplus', 'cijapanese', 'nihongojikan', 'spotify', 'twitch', 'asbplayer', 'generic'];
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

    if (!savedSession) {
      return;
    }

    if (!isValidSavedSession(savedSession)) {
      await saveSessionState(null);
      return;
    }

    const sessionAge = Date.now() - savedSession.lastUpdate;

    if (sessionAge < MAX_RESTORE_AGE_MS) {
      if (savedSession.platform === 'generic') {
        if (savedSession.customSiteHost) {
          savedSession.isActive = false;
          savedSession.isPaused = true;
          tracker.restoreSession(savedSession);
          scheduleStatusBadgeUpdate();
          return;
        }
        if (savedSession.isActive && !savedSession.isPaused && sessionAge > 0) {
          savedSession.accumulatedMs += sessionAge;
          log('[JP343] Recovery: Manual session gap compensation:', Math.round(sessionAge / 1000), 's');
        }
        tracker.restoreSession(savedSession);
        log('[JP343] Recovery: Generic session restored (age:', Math.round(sessionAge / 1000), 's)');
        scheduleStatusBadgeUpdate();
        return;
      }

      if (savedSession.tabId) {
        try {
          await browser.tabs.get(savedSession.tabId);
        } catch {
          log('[JP343] Recovery: Tab gone - finalizing session');
          if (savedSession.accumulatedMs >= 60000) {
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
              activityType: savedSession.activityType,
              serverEntryId: null
            };
            await savePendingEntry(entry);
          }
          await saveSessionState(null);
          scheduleStatusBadgeUpdate();
          return;
        }
      }

      tracker.restoreSession(savedSession);
      const restored = tracker.getCurrentSession();
      if (restored) {
        restored.isActive = false;
        restored.isPaused = true;
      }
      await saveSessionState(restored);
      log('[JP343] Recovery: Video session restored as paused (age:', Math.round(sessionAge / 1000), 's)');
      scheduleStatusBadgeUpdate();
      return;
    }

    if (savedSession.accumulatedMs < 60000) {
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
      activityType: savedSession.activityType,
      serverEntryId: null
    };

    await savePendingEntry(entry);
    await saveSessionState(null);
    log('[JP343] Recovery: Previous session recovered:', entry.project, durationMinutes, 'min');
    } catch (error) {
      log('[JP343] Error during session recovery:', error);
      await saveSessionState(null);
    }
  }

  migrateHourlyMinutes().catch(() => {});
  fetchAndCacheServerStats();
  fetchAndCacheServerSessions();

  // Channel sync: migration + init on SW start
  migrateToChannelSync().catch(() => {});

  // Readers: reconcile runtime registration
  for (const source of READER_SOURCE_LIST) {
    syncReaderRegistration(source).catch(() => {});
  }

  syncCustomSitesRegistration().catch(() => {});

  (async function migrateLocalHubBgFlag(): Promise<void> {
    const flagRes = await browser.storage.local.get(STORAGE_KEYS.MIGRATED_HUB_BG);
    if (flagRes[STORAGE_KEYS.MIGRATED_HUB_BG]) return;

    const settingsRes = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
    const settings = settingsRes[STORAGE_KEYS.SETTINGS] as (ExtensionSettings & { backgroundEnabledHub?: boolean }) | undefined;
    if (!settings || !('backgroundEnabledHub' in settings)) {
      await browser.storage.local.set({ [STORAGE_KEYS.MIGRATED_HUB_BG]: true });
      return;
    }

    let serverHasMigration = false;
    try {
      serverHasMigration = await pullAndMergeSettingsFromServer();
    } catch { return; }
    if (!serverHasMigration) return;

    const userState: JP343UserState | null = (
      await browser.storage.local.get(STORAGE_KEYS.USER)
    )[STORAGE_KEYS.USER] ?? null;
    if (!userState?.isLoggedIn || !userState?.extApiToken) return;

    if (settings.backgroundEnabledHub === true) {
      const ajaxUrl = userState.ajaxUrl || 'https://jp343.com/wp-admin/admin-ajax.php';
      try {
        await fetch(ajaxUrl, {
          method: 'POST',
          body: new URLSearchParams({
            action: 'jp343_extension_push_settings',
            ext_api_token: userState.extApiToken,
            hub_background_enabled: '1',
          }),
        });
      } catch { return; }
    }

    const cleaned = { ...settings };
    delete (cleaned as Record<string, unknown>).backgroundEnabledHub;
    await browser.storage.local.set({ [STORAGE_KEYS.SETTINGS]: cleaned });
    await browser.storage.local.set({ [STORAGE_KEYS.MIGRATED_HUB_BG]: true });
    log('[JP343] Hub BG flag migrated to server');
  })().catch(() => {});

  browser.alarms.create('jp343-check', { periodInMinutes: 5 });

  browser.tabs.onRemoved.addListener(async (tabId) => {
    await recoveryReady;
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
    await recoveryReady;

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
        asbplayer: /app\.asbplayer\.dev/,
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

  browser.tabs.onActivated.addListener(async (activeInfo) => {
    await recoveryReady;
    const session = tracker.getCurrentSession();
    if (!session) return;
    if (session.tabId === activeInfo.tabId) return;

    try {
      await browser.tabs.sendMessage(activeInfo.tabId, { type: 'TAB_ACTIVATED' });
    } catch {
      setTimeout(async () => {
        try {
          await browser.tabs.sendMessage(activeInfo.tabId, { type: 'TAB_ACTIVATED' });
        } catch { /* no content script */ }
      }, 2000);
    }
  });

});
