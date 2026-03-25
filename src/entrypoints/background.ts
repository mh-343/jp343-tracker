import { tracker, generateProjectId } from '../lib/time-tracker';
import type {
  ExtensionMessage,
  PendingEntry,
  TrackingSession,
  JP343UserState,
  ExtensionSettings,
  ExtensionStats,
  BlockedChannel,
  VideoState,
  DirectSyncResult
} from '../types';
import { DEFAULT_SETTINGS, DEFAULT_STATS, STORAGE_KEYS } from '../types';

export default defineBackground(() => {
  const DEBUG_MODE = import.meta.env.DEV;
  const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};

  log('[JP343] Background Service Worker started');


  let storageLock = Promise.resolve();
  function withStorageLock<T>(fn: () => Promise<T>): Promise<T> {
    const p = storageLock.then(() => fn());
    storageLock = p.then(() => {}, () => {});
    return p;
  }

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

  async function loadPendingEntries(): Promise<PendingEntry[]> {
    try {
      const result = await browser.storage.local.get(STORAGE_KEYS.PENDING);
      return result[STORAGE_KEYS.PENDING] || [];
    } catch (error) {
      log('[JP343] Failed to load pending entries:', error);
      return [];
    }
  }

  async function savePendingEntry(entry: PendingEntry): Promise<void> {
    await withStorageLock(async () => {
      try {
        const pending = await loadPendingEntries();
        pending.push(entry);
        await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: pending });
        log('[JP343] Entry saved. Pending:', pending.length);
        updateBadge(pending.length);
        await updateStats(entry);
      } catch (error) {
        log('[JP343] Failed to save entry:', error);
      }
    });
    scheduleAutoSync();
  }

  let autoSyncTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleAutoSync(): void {
    if (autoSyncTimer) return;
    autoSyncTimer = setTimeout(async () => {
      autoSyncTimer = null;
      try {
        const userState: JP343UserState | null = (
          await browser.storage.local.get(STORAGE_KEYS.USER)
        )[STORAGE_KEYS.USER] ?? null;

        if (userState?.isLoggedIn && (userState?.extApiToken || userState?.nonce)) {
          log('[JP343] Auto-sync started');
          const result = await syncEntriesDirect();
          log('[JP343] Auto-sync result:', result.succeeded, 'synced,', result.failed, 'failed');
        }
      } catch (error) {
        log('[JP343] Auto-sync error:', error);
      }
    }, 5000);
  }

  browser.alarms.create('jp343-auto-sync-retry', { periodInMinutes: 5 });
  browser.alarms.create('jp343-cleanup-synced', { periodInMinutes: 360 });

  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'jp343-auto-sync-retry') {
      scheduleAutoSync();
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

  async function syncEntriesDirect(): Promise<DirectSyncResult> {
    const userState: JP343UserState | null = (
      await browser.storage.local.get(STORAGE_KEYS.USER)
    )[STORAGE_KEYS.USER] ?? null;

    if (!userState || !userState.ajaxUrl) {
      return { attempted: 0, succeeded: 0, failed: 0, noAuth: true, nonceMissing: true };
    }

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

    for (const entry of unsynced) {
      try {
        const params: Record<string, string> = {
          action: 'jp343_extension_log_time',
          user_id: String(userState.userId || 0),
          ...(userState.extApiToken
            ? { ext_api_token: userState.extApiToken }
            : { nonce: userState.nonce || '' }),
          project_id: entry.project_id,
          duration_seconds: String(Math.round(entry.duration_min * 60)),
          source: 'extension',
          session_id: entry.id,
          type: 'watching',
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
          date: entry.date.replace('T', ' ').replace(/\.\d+Z$/, '').slice(0, 19)
        };

        if (userState.guestToken) {
          params.guest_token = userState.guestToken;
        }

        const response = await fetch(userState.ajaxUrl, {
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
            const updated = current.map(e =>
              e.id === entry.id
                ? { ...e, synced: true, syncedAt: new Date().toISOString(), lastSyncError: null, serverEntryId: result.data?.entry_id ?? null }
                : e
            );
            await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: updated });
          });
          succeeded++;
          log('[JP343] Direct sync succeeded:', entry.project);
        } else {
          // Auth expired — abort remaining entries
          if (result.data?.code === 'E001' || result.data?.code === 'invalid_nonce' || result.data?.code === 'invalid_token') {
            log('[JP343] Direct sync: Auth expired/invalid, aborting');
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
    return { attempted: unsynced.length, succeeded, failed, noAuth: false, nonceMissing: false };
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

      // Prune entries older than 90 days
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

    // Walk backwards from today
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

  const badgeApi = browser.action ?? browser.browserAction;

  type TrackingStatus = 'recording' | 'paused' | 'ad' | 'idle';

  function getCurrentStatus(): TrackingStatus {
    if (tracker.isAdPlaying()) return 'ad';
    const session = tracker.getCurrentSession();
    if (!session) return 'idle';
    if (session.isPaused) return 'paused';
    if (session.isActive) return 'recording';
    return 'idle';
  }

  let badgeUpdateTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleStatusBadgeUpdate(): void {
    if (badgeUpdateTimer) return;
    badgeUpdateTimer = setTimeout(async () => {
      badgeUpdateTimer = null;
      await updateStatusBadge();
    }, 500);
  }

  async function updateStatusBadge(): Promise<void> {
    const settings = await loadSettings();
    if (!settings.enabled) {
      badgeApi.setBadgeText({ text: 'OFF' });
      badgeApi.setBadgeBackgroundColor({ color: '#6b7280' });
      badgeApi.setTitle({ title: 'jp343 - Tracking disabled' });
      return;
    }

    const status = getCurrentStatus();
    const pending = await loadPendingEntries();
    const unsyncedCount = pending.filter(e => !e.synced).length;

    switch (status) {
      case 'recording':
        badgeApi.setBadgeText({ text: '●' });
        badgeApi.setBadgeBackgroundColor({ color: '#22c55e' });
        badgeApi.setTitle({ title: 'jp343 - Recording...' });
        break;

      case 'paused':
        badgeApi.setBadgeText({ text: '❚❚' });
        badgeApi.setBadgeBackgroundColor({ color: '#f59e0b' });
        badgeApi.setTitle({ title: 'jp343 - Paused' });
        break;

      case 'ad':
        badgeApi.setBadgeText({ text: 'AD' });
        badgeApi.setBadgeBackgroundColor({ color: '#6b7280' });
        badgeApi.setTitle({ title: 'jp343 - Ad playing (not tracking)' });
        break;

      case 'idle':
      default:
        badgeApi.setBadgeText({ text: '' });
        badgeApi.setTitle({ title: 'jp343 Streaming Tracker' });
        break;
    }
  }

  function updateBadge(_count: number): void {
    scheduleStatusBadgeUpdate();
  }

  scheduleStatusBadgeUpdate();

  browser.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse);
    return true; // Async response
  });

  async function handleMessage(
    message: ExtensionMessage,
    sender: browser.Runtime.MessageSender
  ): Promise<unknown> {
    if (!message || typeof message.type !== 'string') {
      return { success: false, error: 'Invalid message format' };
    }

    try {
    switch (message.type) {
      case 'VIDEO_PLAY': {
        const settings = await loadSettings();
        if (!settings.enabled) {
          log('[JP343] Tracking disabled - ignoring VIDEO_PLAY');
          return { success: true, skipped: true };
        }

        if ('state' in message && message.state && typeof message.state === 'object') {
          const channelId = message.state.channelId;
          if (channelId && settings.blockedChannels.some(c => c.channelId === channelId)) {
            log('[JP343] Channel blocked - ignoring VIDEO_PLAY:', channelId);
            return { success: true, skipped: true, blocked: true };
          }

          const currentSession = tracker.getCurrentSession();
          if (currentSession && currentSession.url !== message.state.url) {
            const previousEntry = tracker.finalizeSession();
            if (previousEntry) {
              await savePendingEntry(previousEntry);
              log('[JP343] Previous session saved on video switch:', previousEntry.project, previousEntry.duration_min, 'min');
            }
          }

          if (!message.state.thumbnailUrl) {
            const pending = await loadPendingEntries();
            for (let i = pending.length - 1; i >= 0; i--) {
              if (pending[i].thumbnail && pending[i].url === message.state.url) {
                message.state.thumbnailUrl = pending[i].thumbnail;
                log('[JP343] Thumbnail carried over from previous entry');
                break;
              }
            }
          }

          const tabId = ('tabId' in message ? message.tabId : undefined) || _sender.tab?.id;
          const session = tracker.startSession(message.state, tabId);
          await saveSessionState(session);
          scheduleStatusBadgeUpdate();
        }
        return { success: true };
      }

      case 'VIDEO_PAUSE': {
        tracker.pauseSession();
        const session = tracker.getCurrentSession();
        await saveSessionState(session);
        scheduleStatusBadgeUpdate();
        return { success: true };
      }

      case 'VIDEO_ENDED': {
        const entry = tracker.finalizeSession();
        if (entry) {
          await savePendingEntry(entry);
        }
        await saveSessionState(null);
        scheduleStatusBadgeUpdate();
        return { success: true, saved: !!entry };
      }

      case 'AD_START': {
        tracker.onAdStart();
        scheduleStatusBadgeUpdate();
        return { success: true };
      }

      case 'AD_END': {
        tracker.onAdEnd();
        scheduleStatusBadgeUpdate();
        return { success: true };
      }

      case 'VIDEO_STATE_UPDATE': {
        if ('state' in message && message.state && typeof message.state === 'object') {
          // Only update title if not manually edited
          if (message.state.title) {
            tracker.updateSessionTitleFromAutoFetch(message.state.title);
          }

          if (message.state.channelName) {
            tracker.updateSessionChannelInfo(
              message.state.channelId || null,
              message.state.channelName,
              message.state.channelUrl || null
            );
          }

          if (message.state.thumbnailUrl) {
            tracker.updateSessionThumbnail(message.state.thumbnailUrl);
          }

          if (message.state.channelId) {
            const settings = await loadSettings();
            if (settings.blockedChannels.some(c => c.channelId === message.state.channelId)) {
              log('[JP343] Channel blocked on STATE_UPDATE - stopping session:', message.state.channelId);
              tracker.stopSession();
              await saveSessionState(null);
              scheduleStatusBadgeUpdate();
              return { success: true, blocked: true };
            }
          }
        }
        const session = tracker.getCurrentSession();
        await saveSessionState(session);
        return { success: true };
      }

      case 'GET_CURRENT_SESSION': {
        const session = tracker.getCurrentSession();
        const duration = tracker.getCurrentDuration();
        const isAd = tracker.isAdPlaying();
        const pending = await loadPendingEntries();

        return {
          success: true,
          data: {
            session,
            duration,
            isAd,
            pendingCount: pending.length,
            pendingMinutes: pending.reduce((sum, e) => sum + e.duration_min, 0)
          }
        };
      }

      case 'STOP_SESSION': {
        const sessionBeforeStop = tracker.getCurrentSession();
        if (sessionBeforeStop?.tabId) {
          try {
            await browser.tabs.sendMessage(sessionBeforeStop.tabId, { type: 'PAUSE_VIDEO' });
          } catch { /* tab may no longer exist */ }
        }
        const entry = tracker.stopSession();
        if (entry) {
          await savePendingEntry(entry);
        }
        await saveSessionState(null);
        scheduleStatusBadgeUpdate();
        return { success: true, saved: !!entry };
      }

      case 'PAUSE_SESSION': {
        const sessionToPause = tracker.getCurrentSession();
        if (sessionToPause?.tabId) {
          try {
            await browser.tabs.sendMessage(sessionToPause.tabId, { type: 'PAUSE_VIDEO' });
          } catch { /* tab may no longer exist — manual tracking has no video */ }
        }
        tracker.pauseSession();
        const pausedSession = tracker.getCurrentSession();
        await saveSessionState(pausedSession);
        scheduleStatusBadgeUpdate();
        return { success: true };
      }

      case 'RESUME_SESSION': {
        tracker.resumeSession();
        const resumedSession = tracker.getCurrentSession();
        if (resumedSession?.tabId) {
          try {
            await browser.tabs.sendMessage(resumedSession.tabId, { type: 'RESUME_VIDEO' });
          } catch { /* tab may no longer exist */ }
        }
        await saveSessionState(resumedSession);
        scheduleStatusBadgeUpdate();
        return { success: true };
      }

      case 'JP343_SITE_LOADED': {
        const senderUrl = sender?.url || sender?.tab?.url || '';
        if (!/^https?:\/\/(.*\.)?jp343\.com(\/|$)/i.test(senderUrl) && !senderUrl.startsWith(browser.runtime.getURL(''))) {
          return { success: false, error: 'Unauthorized origin' };
        }
        if ('userState' in message) {
          const newState = message.userState;
          const existing = (await browser.storage.local.get(STORAGE_KEYS.USER))[STORAGE_KEYS.USER] ?? null;
          const merged = {
            ...newState,
            extApiToken: newState?.extApiToken || existing?.extApiToken || null,
          };
          if (!merged.isLoggedIn && merged.extApiToken) {
            merged.isLoggedIn = true;
          }
          await browser.storage.local.set({ [STORAGE_KEYS.USER]: merged });
          log('[JP343] User state updated:', merged.isLoggedIn);
        }
        return { success: true };
      }

      case 'SYNC_ENTRIES_DIRECT': {
        const result = await syncEntriesDirect();
        return { success: true, data: result };
      }

      case 'OPEN_DASHBOARD': {
        await browser.tabs.create({ url: browser.runtime.getURL('dashboard.html') });
        return { success: true };
      }

      case 'GET_PENDING_ENTRIES': {
        const pending = await loadPendingEntries();
        return {
          success: true,
          data: { entries: pending }
        };
      }

      case 'DELETE_PENDING_ENTRY': {
        if ('entryId' in message && typeof message.entryId === 'string') {
          return withStorageLock(async () => {
            const pending = await loadPendingEntries();
            const deletedEntry = pending.find(e => e.id === message.entryId);
            const filtered = pending.filter(e => e.id !== message.entryId);
            await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: filtered });
            const unsyncedCount = filtered.filter(e => !e.synced).length;
            updateBadge(unsyncedCount);
            if (deletedEntry) {
              await subtractFromStats(deletedEntry);
            }
            return { success: true, data: { remaining: filtered.length } };
          });
        }
        return { success: false, error: 'No entryId provided' };
      }

      case 'CLEAR_SYNCED_ENTRIES': {
        return withStorageLock(async () => {
          const pending = await loadPendingEntries();
          const unsynced = pending.filter(e => !e.synced);
          await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: unsynced });
          updateBadge(unsynced.length);
          return { success: true, data: { removed: pending.length - unsynced.length } };
        });
      }

      case 'GET_SETTINGS': {
        const settings = await loadSettings();
        return { success: true, data: { settings } };
      }

      case 'SET_ENABLED': {
        if ('enabled' in message) {
          const settings = await loadSettings();
          settings.enabled = message.enabled;
          await saveSettings(settings);

          if (!message.enabled) {
            const entry = tracker.finalizeSession();
            if (entry) {
              await savePendingEntry(entry);
              log('[JP343] Active session finalized on disable');
            }
            await saveSessionState(null);

            badgeApi.setBadgeText({ text: 'OFF' });
            badgeApi.setBadgeBackgroundColor({ color: '#6b7280' });
            badgeApi.setTitle({ title: 'jp343 - Tracking disabled' });
          } else {
            scheduleStatusBadgeUpdate();
          }

          log('[JP343] Tracking', message.enabled ? 'enabled' : 'disabled');
          return { success: true };
        }
        return { success: false, error: 'No enabled value provided' };
      }

      case 'BLOCK_CHANNEL': {
        if ('channel' in message && message.channel) {
          const settings = await loadSettings();
          if (!settings.blockedChannels.some(c => c.channelId === message.channel.channelId)) {
            settings.blockedChannels.push(message.channel);
            await saveSettings(settings);
            log('[JP343] Channel blocked:', message.channel.channelName);
          }

          const currentSession = tracker.getCurrentSession();
          if (currentSession && currentSession.channelId === message.channel.channelId) {
            log('[JP343] Active session stopped for blocked channel:', message.channel.channelName);
            tracker.stopSession();
            await saveSessionState(null);
            scheduleStatusBadgeUpdate();
          }

          return { success: true };
        }
        return { success: false, error: 'No channel provided' };
      }

      case 'UNBLOCK_CHANNEL': {
        if ('channelId' in message && message.channelId) {
          const settings = await loadSettings();
          const before = settings.blockedChannels.length;
          settings.blockedChannels = settings.blockedChannels.filter(
            c => c.channelId !== message.channelId
          );
          await saveSettings(settings);
          log('[JP343] Channel unblocked:', message.channelId);
          return { success: true, removed: before > settings.blockedChannels.length };
        }
        return { success: false, error: 'No channelId provided' };
      }

      case 'GET_CURRENT_CHANNEL': {
        const session = tracker.getCurrentSession();
        if (session && session.channelId) {
          return {
            success: true,
            data: {
              channelId: session.channelId,
              channelName: session.channelName,
              channelUrl: session.channelUrl,
              platform: session.platform
            }
          };
        }
        return { success: true, data: null };
      }

      case 'UPDATE_SESSION_TITLE': {
        if ('title' in message && message.title) {
          const updated = tracker.updateSessionTitle(message.title as string);
          if (updated) {
            const session = tracker.getCurrentSession();
            await saveSessionState(session);
            log('[JP343] Session title updated:', message.title);
            return { success: true };
          }
          return { success: false, error: 'No active session' };
        }
        return { success: false, error: 'No title provided' };
      }

      case 'UPDATE_PENDING_ENTRY_TITLE': {
        if ('entryId' in message && 'title' in message && typeof message.entryId === 'string' && typeof message.title === 'string' && message.title) {
          return withStorageLock(async () => {
            const pending = await loadPendingEntries();
            const updated = pending.map(e => {
              if (e.id === message.entryId) {
                return { ...e, project: message.title as string };
              }
              return e;
            });
            await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: updated });
            log('[JP343] Pending entry title updated:', message.title);
            return { success: true };
          });
        }
        return { success: false, error: 'No entryId or title provided' };
      }

      case 'GET_ACTIVE_TAB_INFO': {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];
        if (!tab || !tab.url || !tab.id) {
          return { success: false, error: 'No active tab' };
        }

        if (tab.url.startsWith('chrome-extension://') ||
            tab.url.startsWith('moz-extension://') ||
            tab.url.startsWith('about:') ||
            tab.url.startsWith('chrome://') ||
            tab.url.startsWith('edge://')) {
          return { success: false, error: 'Cannot track browser pages' };
        }

        const streamingDomains = [
          /youtube\.com/,
          /netflix\.com/,
          /crunchyroll\.com/,
          /primevideo\.com/,
          /amazon\.\w+.*\/gp\/video/,
          /disneyplus\.com/,
          /cijapanese\.com/
        ];
        const isStreamingSite = streamingDomains.some(p => p.test(tab.url || ''));

        let domain = '';
        try {
          domain = new URL(tab.url).hostname.replace(/^www\./, '');
        } catch { /* ignore */ }

        return {
          success: true,
          data: {
            tabId: tab.id,
            url: tab.url,
            title: tab.title || 'Untitled',
            domain: domain,
            isStreamingSite: isStreamingSite
          }
        };
      }

      case 'MANUAL_TRACK_START': {
        const settings = await loadSettings();
        if (!settings.enabled) {
          return { success: false, error: 'Tracking disabled' };
        }

        if (!('title' in message) || !('url' in message) || !('tabId' in message)) {
          return { success: false, error: 'Missing required fields' };
        }

        // Save previous session if one exists
        const currentSession = tracker.getCurrentSession();
        if (currentSession) {
          const previousEntry = tracker.finalizeSession();
          if (previousEntry) {
            await savePendingEntry(previousEntry);
            log('[JP343] Previous session saved:', previousEntry.project);
          }
        }

        const manualState: VideoState = {
          isPlaying: true,
          currentTime: 0,
          duration: 0,
          title: message.title as string,
          url: message.url as string,
          platform: 'generic',
          isAd: false,
          thumbnailUrl: null,
          videoId: null,
          channelId: null,
          channelName: null,
          channelUrl: null
        };

        const session = tracker.startSession(manualState, message.tabId as number);
        await saveSessionState(session);
        scheduleStatusBadgeUpdate();

        log('[JP343] Manual tracking started:', message.title);
        return { success: true, data: { session } };
      }

      case 'GET_STATS': {
        const stats = await loadStats();

        const now = new Date();
        const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon...
        const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
        const monday = new Date(now);
        monday.setDate(now.getDate() + mondayOffset);
        monday.setHours(0, 0, 0, 0);
        const mondayStr = monday.toISOString().split('T')[0];

        let weekMinutes = 0;
        const todayStr = now.toISOString().split('T')[0];
        const todayMinutes = stats.dailyMinutes[todayStr] || 0;

        for (const [dateKey, minutes] of Object.entries(stats.dailyMinutes)) {
          if (dateKey >= mondayStr) {
            weekMinutes += minutes;
          }
        }

        let streak = stats.currentStreak;
        if (stats.lastActiveDate) {
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const yesterdayStr = yesterday.toISOString().split('T')[0];
          if (stats.lastActiveDate !== todayStr && stats.lastActiveDate !== yesterdayStr) {
            streak = 0;
          }
        }

        return {
          success: true,
          data: {
            totalMinutes: stats.totalMinutes,
            weekMinutes,
            todayMinutes,
            streak,
            rawDailyMinutes: stats.dailyMinutes
          }
        };
      }

      case 'RESET_STATS': {
        await browser.storage.local.set({ [STORAGE_KEYS.STATS]: { ...DEFAULT_STATS } });
        log('[JP343] Stats reset');
        return { success: true };
      }

      default:
        return { success: false, error: 'Unknown message type' };
    }
    } catch (error) {
      log('[JP343] Error in handleMessage:', message.type, error);
      return { success: false, error: 'Internal error' };
    }
  }

  const MAX_RESTORE_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

  const VALID_PLATFORMS = ['youtube', 'netflix', 'crunchyroll', 'primevideo', 'disneyplus', 'generic'];
  const MIN_VALID_TIMESTAMP = 1704067200000; // Jan 1, 2024

  function isValidSavedSession(session: unknown): session is TrackingSession {
    if (!session || typeof session !== 'object') return false;
    const s = session as Record<string, unknown>;
    return (
      typeof s.title === 'string' &&
      typeof s.url === 'string' &&
      typeof s.startTime === 'number' && s.startTime > MIN_VALID_TIMESTAMP &&
      typeof s.accumulatedMs === 'number' && s.accumulatedMs >= 0 &&
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
      channelUrl: savedSession.channelUrl
    };

    await savePendingEntry(entry);
    await saveSessionState(null);
    log('[JP343] Recovery: Previous session recovered:', entry.project, durationMinutes, 'min');
    } catch (error) {
      log('[JP343] Error during session recovery:', error);
      await saveSessionState(null);
    }
  }

  recoverSession();

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
          // Same domain — keep session, update URL
          tracker.updateSessionUrl(changeInfo.url);
          const updatedSession = tracker.getCurrentSession();
          await saveSessionState(updatedSession);
          log('[JP343] Navigation within domain - session continues');
        }
      } catch {
        // URL parsing failed — end session to be safe
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
