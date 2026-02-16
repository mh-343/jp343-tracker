// JP343 Extension - Background Service Worker

import { tracker } from '../lib/time-tracker';
import type {
  ExtensionMessage,
  PendingEntry,
  TrackingSession,
  JP343UserState,
  ExtensionSettings,
  BlockedChannel,
  VideoState
} from '../types';
import { DEFAULT_SETTINGS } from '../types';

export default defineBackground(() => {
  const DEBUG_MODE = import.meta.env.DEV;
  const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};

  log('[JP343] Background Service Worker gestartet');

  // Storage Keys
  const STORAGE_KEYS = {
    PENDING: 'jp343_extension_pending',
    SESSION: 'jp343_extension_session',
    USER: 'jp343_extension_user',
    SETTINGS: 'jp343_extension_settings'
  };

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
      console.error('[JP343] Fehler beim Laden der Settings:', error);
      return { ...DEFAULT_SETTINGS };
    }
  }

  async function saveSettings(settings: ExtensionSettings): Promise<void> {
    cachedSettings = { ...settings };
    try {
      await browser.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
    } catch (error) {
      console.error('[JP343] Fehler beim Speichern der Settings:', error);
    }
  }

  // Pending Entries laden
  async function loadPendingEntries(): Promise<PendingEntry[]> {
    try {
      const result = await browser.storage.local.get(STORAGE_KEYS.PENDING);
      return result[STORAGE_KEYS.PENDING] || [];
    } catch (error) {
      console.error('[JP343] Fehler beim Laden der Pending Entries:', error);
      return [];
    }
  }

  // Pending Entry speichern
  async function savePendingEntry(entry: PendingEntry): Promise<void> {
    await withStorageLock(async () => {
      try {
        const pending = await loadPendingEntries();
        pending.push(entry);
        await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: pending });
        log('[JP343] Entry gespeichert. Pending:', pending.length);
        // Badge aktualisieren
        updateBadge(pending.length);
      } catch (error) {
        console.error('[JP343] Fehler beim Speichern des Entries:', error);
      }
    });
  }

  async function saveSessionState(session: TrackingSession | null): Promise<void> {
    try {
      await browser.storage.local.set({ [STORAGE_KEYS.SESSION]: session });
    } catch (error) {
      console.error('[JP343] Fehler beim Speichern des Session-States:', error);
    }
  }

  // STATUS INDICATOR: Visuelles Feedback auf Extension-Icon

  const badgeApi = browser.action ?? browser.browserAction;

  type TrackingStatus = 'recording' | 'paused' | 'ad' | 'idle';

  // Aktuellen Status ermitteln
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
      await _doUpdateStatusBadge();
    }, 500);
  }

  async function _doUpdateStatusBadge(): Promise<void> {
    // Pruefen ob Tracking aktiviert ist
    const settings = await loadSettings();
    if (!settings.enabled) {
      badgeApi.setBadgeText({ text: 'OFF' });
      badgeApi.setBadgeBackgroundColor({ color: '#6b7280' }); // Gray
      badgeApi.setTitle({ title: 'JP343 - Tracking disabled' });
      return;
    }

    const status = getCurrentStatus();
    const pending = await loadPendingEntries();
    const unsyncedCount = pending.filter(e => !e.synced).length;

    switch (status) {
      case 'recording':
        // Gruen mit Record-Symbol
        badgeApi.setBadgeText({ text: '●' });
        badgeApi.setBadgeBackgroundColor({ color: '#22c55e' }); // Green
        badgeApi.setTitle({ title: 'JP343 - Recording...' });
        break;

      case 'paused':
        // Orange mit Pause-Symbol
        badgeApi.setBadgeText({ text: '❚❚' });
        badgeApi.setBadgeBackgroundColor({ color: '#f59e0b' }); // Amber
        badgeApi.setTitle({ title: 'JP343 - Paused' });
        break;

      case 'ad':
        badgeApi.setBadgeText({ text: 'AD' });
        badgeApi.setBadgeBackgroundColor({ color: '#6b7280' }); // Gray
        badgeApi.setTitle({ title: 'JP343 - Ad playing (not tracking)' });
        break;

      case 'idle':
      default:
        if (unsyncedCount > 0) {
          badgeApi.setBadgeText({ text: String(unsyncedCount) });
          badgeApi.setBadgeBackgroundColor({ color: '#875aff' }); // JP343 accent
          badgeApi.setTitle({ title: `JP343 - ${unsyncedCount} pending entries` });
        } else {
          badgeApi.setBadgeText({ text: '' });
          badgeApi.setTitle({ title: 'JP343 Streaming Tracker' });
        }
        break;
    }
  }

  function updateBadge(_count: number): void {
    scheduleStatusBadgeUpdate();
  }

  // Initiales Badge-Update
  scheduleStatusBadgeUpdate();

  // Message Handler
  browser.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse);
    return true; // Async response
  });

  async function handleMessage(
    message: ExtensionMessage,
    _sender: browser.Runtime.MessageSender
  ): Promise<unknown> {
    // Message-Validierung
    if (!message || typeof message.type !== 'string') {
      return { success: false, error: 'Invalid message format' };
    }

    try {
    switch (message.type) {
      case 'VIDEO_PLAY': {
        // Pruefen ob Tracking aktiviert ist
        const settings = await loadSettings();
        if (!settings.enabled) {
          log('[JP343] Tracking deaktiviert - ignoriere VIDEO_PLAY');
          return { success: true, skipped: true };
        }

        if ('state' in message && message.state && typeof message.state === 'object') {
          // Pruefen ob Kanal blockiert ist
          const channelId = message.state.channelId;
          if (channelId && settings.blockedChannels.some(c => c.channelId === channelId)) {
            log('[JP343] Kanal blockiert - ignoriere VIDEO_PLAY:', channelId);
            return { success: true, skipped: true, blocked: true };
          }

          const currentSession = tracker.getCurrentSession();
          if (currentSession && currentSession.url !== message.state.url) {
            const previousEntry = tracker.finalizeSession();
            if (previousEntry) {
              await savePendingEntry(previousEntry);
              log('[JP343] Vorherige Session gespeichert bei Video-Wechsel:', previousEntry.project, previousEntry.duration_min, 'min');
            }
          }

          // vom letzten Entry mit gleicher project_id uebernehmen
          if (!message.state.thumbnailUrl) {
            const pending = await loadPendingEntries();
            for (let i = pending.length - 1; i >= 0; i--) {
              if (pending[i].thumbnail && pending[i].url === message.state.url) {
                message.state.thumbnailUrl = pending[i].thumbnail;
                log('[JP343] Thumbnail von vorherigem Entry uebernommen');
                break;
              }
            }
          }

          const tabId = ('tabId' in message ? message.tabId : undefined) || _sender.tab?.id;
          const session = tracker.startSession(message.state, tabId);
          await saveSessionState(session);
          scheduleStatusBadgeUpdate(); // Status-Icon aktualisieren
        }
        return { success: true };
      }

      case 'VIDEO_PAUSE': {
        tracker.pauseSession();
        const session = tracker.getCurrentSession();
        await saveSessionState(session);
        scheduleStatusBadgeUpdate(); // Status-Icon aktualisieren
        return { success: true };
      }

      case 'VIDEO_ENDED': {
        const entry = tracker.finalizeSession();
        if (entry) {
          await savePendingEntry(entry);
        }
        await saveSessionState(null);
        scheduleStatusBadgeUpdate(); // Status-Icon aktualisieren
        return { success: true, saved: !!entry };
      }

      case 'AD_START': {
        tracker.onAdStart();
        scheduleStatusBadgeUpdate(); // Status-Icon aktualisieren
        return { success: true };
      }

      case 'AD_END': {
        tracker.onAdEnd();
        scheduleStatusBadgeUpdate(); // Status-Icon aktualisieren
        return { success: true };
      }

      case 'VIDEO_STATE_UPDATE': {
        // Session laeuft weiter, nur State-Update
        if ('state' in message && message.state && typeof message.state === 'object') {
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
              log('[JP343] Kanal blockiert bei STATE_UPDATE - stoppe Session:', message.state.channelId);
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
        const entry = tracker.stopSession();
        if (entry) {
          await savePendingEntry(entry);
        }
        await saveSessionState(null);
        scheduleStatusBadgeUpdate(); // Status-Icon aktualisieren
        return { success: true, saved: !!entry };
      }

      case 'PAUSE_SESSION': {
        tracker.pauseSession();
        const session = tracker.getCurrentSession();
        await saveSessionState(session);
        scheduleStatusBadgeUpdate(); // Status-Icon aktualisieren
        return { success: true };
      }

      case 'RESUME_SESSION': {
        tracker.resumeSession();
        const session = tracker.getCurrentSession();
        await saveSessionState(session);
        scheduleStatusBadgeUpdate(); // Status-Icon aktualisieren
        return { success: true };
      }

      case 'JP343_SITE_LOADED': {
        // JP343 Seite geladen - User State speichern
        if ('userState' in message) {
          await browser.storage.local.set({
            [STORAGE_KEYS.USER]: message.userState
          });
          log('[JP343] User State aktualisiert:', message.userState?.isLoggedIn);
        }
        return { success: true };
      }

      case 'SYNC_NOW': {
        // Manueller Sync-Trigger (vom Popup)
        const pending = await loadPendingEntries();
        return {
          success: true,
          data: { pendingCount: pending.length }
        };
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
            const filtered = pending.filter(e => e.id !== message.entryId);
            await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: filtered });
            const unsyncedCount = filtered.filter(e => !e.synced).length;
            updateBadge(unsyncedCount);
            return { success: true, data: { remaining: filtered.length } };
          });
        }
        return { success: false, error: 'No entryId provided' };
      }

      case 'MARK_ENTRY_SYNCED': {
        if ('entryId' in message && typeof message.entryId === 'string') {
          return withStorageLock(async () => {
            const pending = await loadPendingEntries();
            const updated = pending.map(e => {
              if (e.id === message.entryId) {
                return {
                  ...e,
                  synced: true,
                  syncedAt: new Date().toISOString(),
                  lastSyncError: null
                };
              }
              return e;
            });
            await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: updated });
            const unsyncedCount = updated.filter(e => !e.synced).length;
            updateBadge(unsyncedCount);
            return { success: true };
          });
        }
        return { success: false, error: 'No entryId provided' };
      }

      case 'MARK_ENTRY_FAILED': {
        if ('entryId' in message && typeof message.entryId === 'string') {
          return withStorageLock(async () => {
            const pending = await loadPendingEntries();
            const updated = pending.map(e => {
              if (e.id === message.entryId) {
                return {
                  ...e,
                  syncAttempts: e.syncAttempts + 1,
                  lastSyncError: ('error' in message ? message.error : 'Unknown error') as string
                };
              }
              return e;
            });
            await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: updated });
            return { success: true };
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
            badgeApi.setBadgeText({ text: 'OFF' });
            badgeApi.setBadgeBackgroundColor({ color: '#6b7280' }); // Gray
            badgeApi.setTitle({ title: 'JP343 - Tracking disabled' });
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
          // Pruefen ob bereits blockiert
          if (!settings.blockedChannels.some(c => c.channelId === message.channel.channelId)) {
            settings.blockedChannels.push(message.channel);
            await saveSettings(settings);
            log('[JP343] Kanal blockiert:', message.channel.channelName);
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
          log('[JP343] Kanal entblockiert:', message.channelId);
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
            log('[JP343] Session-Titel aktualisiert:', message.title);
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
            log('[JP343] Pending Entry Titel aktualisiert:', message.title);
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
          /crunchyroll\.com/
        ];
        const isStreamingSite = streamingDomains.some(p => p.test(tab.url || ''));

        // Domain extrahieren
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
        // Manuelles Tracking starten
        const settings = await loadSettings();
        if (!settings.enabled) {
          return { success: false, error: 'Tracking disabled' };
        }

        if (!('title' in message) || !('url' in message) || !('tabId' in message)) {
          return { success: false, error: 'Missing required fields' };
        }

        const currentSession = tracker.getCurrentSession();
        if (currentSession) {
          const previousEntry = tracker.finalizeSession();
          if (previousEntry) {
            await savePendingEntry(previousEntry);
            log('[JP343] Vorherige Session gespeichert:', previousEntry.project);
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

        log('[JP343] Manual Tracking gestartet:', message.title);
        return { success: true, data: { session } };
      }

      default:
        return { success: false, error: 'Unknown message type' };
    }
    } catch (error) {
      console.error('[JP343] Fehler in handleMessage:', message.type, error);
      return { success: false, error: 'Internal error' };
    }
  }

  const VALID_PLATFORMS = ['youtube', 'netflix', 'crunchyroll', 'generic'];
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
      log('[JP343] Recovery: Ungueltige Session-Daten, wird verworfen');
      await saveSessionState(null);
      return;
    }

    if (savedSession.accumulatedMs < 60000) {
      log('[JP343] Recovery: Session zu kurz (<1min), wird verworfen');
      await saveSessionState(null);
      return;
    }

    const durationMinutes = savedSession.accumulatedMs / 60000;

    // generateProjectId Logik replizieren
    const normalized = savedSession.title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 30);
    const projectId = savedSession.videoId
      ? `ext_${savedSession.platform}_${savedSession.videoId}`
      : `ext_${savedSession.platform}_${normalized}`;

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
    log('[JP343] Recovery: Vorherige Session gerettet:', entry.project, durationMinutes, 'min');
    } catch (error) {
      console.error('[JP343] Fehler bei Session Recovery:', error);
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
        log('[JP343] Periodic save - Session gesichert:', session.title, Math.round(session.accumulatedMs / 1000), 's');
      }

      const pending = await loadPendingEntries();
      log('[JP343] Periodic check - Pending entries:', pending.length);
    }
  });


  // Tab geschlossen -> Session speichern
  browser.tabs.onRemoved.addListener(async (tabId) => {
    const session = tracker.getCurrentSession();
    if (session && session.tabId === tabId) {
      log('[JP343] Tab geschlossen - speichere Session');
      const entry = tracker.finalizeSession();
      if (entry) {
        await savePendingEntry(entry);
      }
      await saveSessionState(null);
      scheduleStatusBadgeUpdate(); // Status-Icon aktualisieren
    }
  });

  // URL geaendert -> Pruefen ob Session beendet werden soll
  browser.tabs.onUpdated.addListener(async (tabId, changeInfo, _tab) => {
    if (!changeInfo.url) return;

    const session = tracker.getCurrentSession();
    if (!session || session.tabId !== tabId) return;

    if (session.platform === 'generic') {
      try {
        const sessionDomain = new URL(session.url).hostname;
        const newDomain = new URL(changeInfo.url).hostname;
        if (sessionDomain !== newDomain) {
          log('[JP343] Domain gewechselt - speichere manuelle Session');
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
          log('[JP343] Navigation innerhalb Domain - Session laeuft weiter');
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
      };
      const samePlatform = platformDomains[session.platform]?.test(changeInfo.url);
      if (!samePlatform) {
        log('[JP343] Navigation weg von Plattform - speichere Session');
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
