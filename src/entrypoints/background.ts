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
  console.log('[JP343] Background Service Worker gestartet');

  // Storage Keys
  const STORAGE_KEYS = {
    PENDING: 'jp343_extension_pending',
    SESSION: 'jp343_extension_session',
    USER: 'jp343_extension_user',
    SETTINGS: 'jp343_extension_settings'
  };

  // Settings laden
  async function loadSettings(): Promise<ExtensionSettings> {
    const result = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, ...result[STORAGE_KEYS.SETTINGS] };
  }

  // Settings speichern
  async function saveSettings(settings: ExtensionSettings): Promise<void> {
    await browser.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
  }

  // Pending Entries laden
  async function loadPendingEntries(): Promise<PendingEntry[]> {
    const result = await browser.storage.local.get(STORAGE_KEYS.PENDING);
    return result[STORAGE_KEYS.PENDING] || [];
  }

  // Pending Entry speichern
  async function savePendingEntry(entry: PendingEntry): Promise<void> {
    const pending = await loadPendingEntries();
    pending.push(entry);
    await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: pending });
    console.log('[JP343] Entry gespeichert. Pending:', pending.length);

    // Badge aktualisieren
    updateBadge(pending.length);
  }

  async function saveSessionState(session: TrackingSession | null): Promise<void> {
    await browser.storage.local.set({ [STORAGE_KEYS.SESSION]: session });
  }

  // STATUS INDICATOR: Visuelles Feedback auf Extension-Icon

  type TrackingStatus = 'recording' | 'paused' | 'ad' | 'idle';

  // Aktuellen Status ermitteln
  function getCurrentStatus(): TrackingStatus {
    const session = tracker.getCurrentSession();
    if (!session) return 'idle';
    if (tracker.isAdPlaying()) return 'ad';
    if (session.isPaused) return 'paused';
    if (session.isActive) return 'recording';
    return 'idle';
  }

  async function updateStatusBadge(): Promise<void> {
    // Pruefen ob Tracking aktiviert ist
    const settings = await loadSettings();
    if (!settings.enabled) {
      browser.action.setBadgeText({ text: 'OFF' });
      browser.action.setBadgeBackgroundColor({ color: '#6b7280' }); // Gray
      browser.action.setTitle({ title: 'JP343 - Tracking disabled' });
      return;
    }

    const status = getCurrentStatus();
    const pending = await loadPendingEntries();
    const unsyncedCount = pending.filter(e => !e.synced).length;

    switch (status) {
      case 'recording':
        // Gruen mit Record-Symbol
        browser.action.setBadgeText({ text: '●' });
        browser.action.setBadgeBackgroundColor({ color: '#22c55e' }); // Green
        browser.action.setTitle({ title: 'JP343 - Recording...' });
        break;

      case 'paused':
        // Orange mit Pause-Symbol
        browser.action.setBadgeText({ text: '❚❚' });
        browser.action.setBadgeBackgroundColor({ color: '#f59e0b' }); // Amber
        browser.action.setTitle({ title: 'JP343 - Paused' });
        break;

      case 'ad':
        browser.action.setBadgeText({ text: 'AD' });
        browser.action.setBadgeBackgroundColor({ color: '#6b7280' }); // Gray
        browser.action.setTitle({ title: 'JP343 - Ad playing (not tracking)' });
        break;

      case 'idle':
      default:
        if (unsyncedCount > 0) {
          browser.action.setBadgeText({ text: String(unsyncedCount) });
          browser.action.setBadgeBackgroundColor({ color: '#875aff' }); // JP343 accent
          browser.action.setTitle({ title: `JP343 - ${unsyncedCount} pending entries` });
        } else {
          browser.action.setBadgeText({ text: '' });
          browser.action.setTitle({ title: 'JP343 Streaming Tracker' });
        }
        break;
    }
  }

  function updateBadge(_count: number): void {
    updateStatusBadge();
  }

  // Initiales Badge-Update
  updateStatusBadge();

  // Message Handler
  browser.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse);
    return true; // Async response
  });

  async function handleMessage(
    message: ExtensionMessage,
    _sender: browser.Runtime.MessageSender
  ): Promise<unknown> {
    switch (message.type) {
      case 'VIDEO_PLAY': {
        // Pruefen ob Tracking aktiviert ist
        const settings = await loadSettings();
        if (!settings.enabled) {
          console.log('[JP343] Tracking deaktiviert - ignoriere VIDEO_PLAY');
          return { success: true, skipped: true };
        }

        if ('state' in message && message.state) {
          // Pruefen ob Kanal blockiert ist
          const channelId = message.state.channelId;
          if (channelId && settings.blockedChannels.some(c => c.channelId === channelId)) {
            console.log('[JP343] Kanal blockiert - ignoriere VIDEO_PLAY:', channelId);
            return { success: true, skipped: true, blocked: true };
          }

          const currentSession = tracker.getCurrentSession();
          if (currentSession && currentSession.url !== message.state.url) {
            const previousEntry = tracker.finalizeSession();
            if (previousEntry) {
              await savePendingEntry(previousEntry);
              console.log('[JP343] Vorherige Session gespeichert bei Video-Wechsel:', previousEntry.project, previousEntry.duration_min, 'min');
            }
          }

          const tabId = ('tabId' in message ? message.tabId : undefined) || _sender.tab?.id;
          const session = tracker.startSession(message.state, tabId);
          await saveSessionState(session);
          await updateStatusBadge(); // Status-Icon aktualisieren
        }
        return { success: true };
      }

      case 'VIDEO_PAUSE': {
        tracker.pauseSession();
        const session = tracker.getCurrentSession();
        await saveSessionState(session);
        await updateStatusBadge(); // Status-Icon aktualisieren
        return { success: true };
      }

      case 'VIDEO_ENDED': {
        const entry = tracker.finalizeSession();
        if (entry) {
          await savePendingEntry(entry);
        }
        await saveSessionState(null);
        await updateStatusBadge(); // Status-Icon aktualisieren
        return { success: true, saved: !!entry };
      }

      case 'AD_START': {
        tracker.onAdStart();
        await updateStatusBadge(); // Status-Icon aktualisieren
        return { success: true };
      }

      case 'AD_END': {
        tracker.onAdEnd();
        await updateStatusBadge(); // Status-Icon aktualisieren
        return { success: true };
      }

      case 'VIDEO_STATE_UPDATE': {
        // Session laeuft weiter, nur State-Update
        if ('state' in message && message.state) {
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
        await updateStatusBadge(); // Status-Icon aktualisieren
        return { success: true, saved: !!entry };
      }

      case 'PAUSE_SESSION': {
        tracker.pauseSession();
        const session = tracker.getCurrentSession();
        await saveSessionState(session);
        await updateStatusBadge(); // Status-Icon aktualisieren
        return { success: true };
      }

      case 'RESUME_SESSION': {
        tracker.resumeSession();
        const session = tracker.getCurrentSession();
        await saveSessionState(session);
        await updateStatusBadge(); // Status-Icon aktualisieren
        return { success: true };
      }

      case 'JP343_SITE_LOADED': {
        // JP343 Seite geladen - User State speichern
        if ('userState' in message) {
          await browser.storage.local.set({
            [STORAGE_KEYS.USER]: message.userState
          });
          console.log('[JP343] User State aktualisiert:', message.userState?.isLoggedIn);
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
        if ('entryId' in message && message.entryId) {
          const pending = await loadPendingEntries();
          const filtered = pending.filter(e => e.id !== message.entryId);
          await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: filtered });
          const unsyncedCount = filtered.filter(e => !e.synced).length;
          updateBadge(unsyncedCount);
          return { success: true, data: { remaining: filtered.length } };
        }
        return { success: false, error: 'No entryId provided' };
      }

      case 'MARK_ENTRY_SYNCED': {
        if ('entryId' in message && message.entryId) {
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
        }
        return { success: false, error: 'No entryId provided' };
      }

      case 'MARK_ENTRY_FAILED': {
        if ('entryId' in message && message.entryId) {
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
        }
        return { success: false, error: 'No entryId provided' };
      }

      case 'CLEAR_SYNCED_ENTRIES': {
        const pending = await loadPendingEntries();
        const unsynced = pending.filter(e => !e.synced);
        await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: unsynced });
        updateBadge(unsynced.length);
        return { success: true, data: { removed: pending.length - unsynced.length } };
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
            browser.action.setBadgeText({ text: 'OFF' });
            browser.action.setBadgeBackgroundColor({ color: '#6b7280' }); // Gray
            browser.action.setTitle({ title: 'JP343 - Tracking disabled' });
          } else {
            await updateStatusBadge();
          }

          console.log('[JP343] Tracking', message.enabled ? 'enabled' : 'disabled');
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
            console.log('[JP343] Kanal blockiert:', message.channel.channelName);
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
          console.log('[JP343] Kanal entblockiert:', message.channelId);
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
            console.log('[JP343] Session-Titel aktualisiert:', message.title);
            return { success: true };
          }
          return { success: false, error: 'No active session' };
        }
        return { success: false, error: 'No title provided' };
      }

      case 'UPDATE_PENDING_ENTRY_TITLE': {
        if ('entryId' in message && 'title' in message && message.entryId && message.title) {
          const pending = await loadPendingEntries();
          const updated = pending.map(e => {
            if (e.id === message.entryId) {
              return { ...e, project: message.title as string };
            }
            return e;
          });
          await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: updated });
          console.log('[JP343] Pending Entry Titel aktualisiert:', message.title);
          return { success: true };
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

        const streamingPatterns = [
          /youtube\.com\/watch/,
          /netflix\.com\/watch/,
          /crunchyroll\.com\/watch/
        ];
        const isStreamingSite = streamingPatterns.some(p => p.test(tab.url || ''));

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
            console.log('[JP343] Vorherige Session gespeichert:', previousEntry.project);
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
        await updateStatusBadge();

        console.log('[JP343] Manual Tracking gestartet:', message.title);
        return { success: true, data: { session } };
      }

      default:
        return { success: false, error: 'Unknown message type' };
    }
  }

  // Session Recovery beim Start
  async function recoverSession(): Promise<void> {
    const result = await browser.storage.local.get(STORAGE_KEYS.SESSION);
    const savedSession = result[STORAGE_KEYS.SESSION] as TrackingSession | null;

    if (savedSession && savedSession.isActive) {
      console.log('[JP343] Vorherige Session gefunden, aber nicht wiederhergestellt');
    }
  }

  recoverSession();

  browser.alarms.create('jp343-check', { periodInMinutes: 5 });

  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'jp343-check') {
      const pending = await loadPendingEntries();
      console.log('[JP343] Periodic check - Pending entries:', pending.length);
    }
  });


  // Tab geschlossen -> Session speichern
  browser.tabs.onRemoved.addListener(async (tabId) => {
    const session = tracker.getCurrentSession();
    if (session && session.tabId === tabId) {
      console.log('[JP343] Tab geschlossen - speichere Session');
      const entry = tracker.finalizeSession();
      if (entry) {
        await savePendingEntry(entry);
      }
      await saveSessionState(null);
      await updateStatusBadge(); // Status-Icon aktualisieren
    }
  });

  browser.tabs.onUpdated.addListener(async (tabId, changeInfo, _tab) => {
    if (changeInfo.url) {
      const session = tracker.getCurrentSession();
      if (session && session.tabId === tabId) {
        const isStreamingSite = /youtube\.com\/watch|netflix\.com\/watch/.test(changeInfo.url);
        if (!isStreamingSite) {
          console.log('[JP343] Navigation weg von Video - speichere Session');
          const entry = tracker.finalizeSession();
          if (entry) {
            await savePendingEntry(entry);
          }
          await saveSessionState(null);
          await updateStatusBadge(); // Status-Icon aktualisieren
        }
      }
    }
  });
});
