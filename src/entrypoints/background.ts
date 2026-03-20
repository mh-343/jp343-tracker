// =============================================================================
// JP343 Extension - Background Service Worker
// Zentrale Steuerung: Empfaengt Messages, verwaltet TimeTracker, speichert Daten
// =============================================================================

import { tracker } from '../lib/time-tracker';
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
import { DEFAULT_SETTINGS, DEFAULT_STATS } from '../types';

export default defineBackground(() => {
  const DEBUG_MODE = import.meta.env.DEV;
  const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};

  log('[JP343] Background Service Worker gestartet');

  // Storage Keys
  const STORAGE_KEYS = {
    PENDING: 'jp343_extension_pending',
    SESSION: 'jp343_extension_session',
    USER: 'jp343_extension_user',
    SETTINGS: 'jp343_extension_settings',
    STATS: 'jp343_extension_stats'
  };

  // Storage Mutex: Verhindert Race Conditions bei gleichzeitigen Load-Modify-Save Operationen
  let storageLock = Promise.resolve();
  function withStorageLock<T>(fn: () => Promise<T>): Promise<T> {
    const p = storageLock.then(() => fn());
    storageLock = p.then(() => {}, () => {});
    return p;
  }

  // Settings laden (gecached, Fix Iteration 6: spart Storage-Read pro Badge-Update)
  let cachedSettings: ExtensionSettings | null = null;

  async function loadSettings(): Promise<ExtensionSettings> {
    if (cachedSettings) return { ...cachedSettings };
    try {
      const result = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
      cachedSettings = { ...DEFAULT_SETTINGS, ...result[STORAGE_KEYS.SETTINGS] };
      return { ...cachedSettings };
    } catch (error) {
      log('[JP343] Fehler beim Laden der Settings:', error);
      return { ...DEFAULT_SETTINGS };
    }
  }

  // Settings speichern (aktualisiert auch Cache)
  async function saveSettings(settings: ExtensionSettings): Promise<void> {
    cachedSettings = { ...settings };
    try {
      await browser.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
    } catch (error) {
      log('[JP343] Fehler beim Speichern der Settings:', error);
    }
  }

  // Pending Entries laden
  async function loadPendingEntries(): Promise<PendingEntry[]> {
    try {
      const result = await browser.storage.local.get(STORAGE_KEYS.PENDING);
      return result[STORAGE_KEYS.PENDING] || [];
    } catch (error) {
      log('[JP343] Fehler beim Laden der Pending Entries:', error);
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
        // Stats aktualisieren
        await updateStats(entry);
      } catch (error) {
        log('[JP343] Fehler beim Speichern des Entries:', error);
      }
    });
    // Auto-Sync starten wenn eingeloggt
    scheduleAutoSync();
  }

  // ==========================================================================
  // AUTO-SYNC: Automatisch syncen wenn eingeloggt (5s Debounce)
  // ==========================================================================

  let autoSyncTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleAutoSync(): void {
    if (autoSyncTimer) return; // Debounce — nicht mehrfach starten
    autoSyncTimer = setTimeout(async () => {
      autoSyncTimer = null;
      try {
        const userState: JP343UserState | null = (
          await browser.storage.local.get(STORAGE_KEYS.USER)
        )[STORAGE_KEYS.USER] ?? null;

        if (userState?.isLoggedIn && userState?.nonce) {
          log('[JP343] Auto-Sync gestartet');
          const result = await syncEntriesDirect();
          log('[JP343] Auto-Sync Ergebnis:', result.succeeded, 'synced,', result.failed, 'failed');
        }
      } catch (error) {
        log('[JP343] Auto-Sync Fehler:', error);
      }
    }, 5000);
  }

  // Retry-Alarm: alle 5 Minuten fehlgeschlagene Entries erneut syncen
  browser.alarms.create('jp343-auto-sync-retry', { periodInMinutes: 5 });
  // Cleanup-Alarm: alle 6 Stunden synced Entries aelter als 24h entfernen
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
          log('[JP343] Cleanup: ' + (pending.length - cleaned.length) + ' alte synced Entries entfernt');
        }
      });
    }
  });

  // ==========================================================================
  // DIRECT SYNC: Sync ohne Bridge-Content-Script direkt aus dem Service Worker
  // ==========================================================================

  async function syncEntriesDirect(): Promise<DirectSyncResult> {
    const userState: JP343UserState | null = (
      await browser.storage.local.get(STORAGE_KEYS.USER)
    )[STORAGE_KEYS.USER] ?? null;

    // Kein User State gecacht — User hat jp343.com noch nicht besucht
    if (!userState || !userState.ajaxUrl) {
      return { attempted: 0, succeeded: 0, failed: 0, noAuth: true, nonceMissing: true };
    }

    // Weder eingeloggt noch Gast-Token — kein Sync moeglich
    const hasAuth = userState.isLoggedIn || !!userState.guestToken;
    if (!hasAuth || !userState.nonce) {
      return { attempted: 0, succeeded: 0, failed: 0, noAuth: true, nonceMissing: !userState.nonce };
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
          nonce: userState.nonce,
          user_id: String(userState.userId || 0),
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
          date: entry.date.split('T')[0] // YYYY-MM-DD
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

        let result: any;
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
          log('[JP343] Direct Sync erfolgreich:', entry.project);
        } else {
          // Nonce abgelaufen? Restliche Entries abbrechen
          if (result.data?.code === 'E001' || result.data?.code === 'invalid_nonce') {
            log('[JP343] Direct Sync: Nonce abgelaufen, breche ab');
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
        log('[JP343] Direct Sync Fehler:', entry.id, error);
      }
    }

    scheduleStatusBadgeUpdate();
    return { attempted: unsynced.length, succeeded, failed, noAuth: false, nonceMissing: false };
  }

  // Session-State speichern (fuer Recovery nach Browser-Neustart)
  async function saveSessionState(session: TrackingSession | null): Promise<void> {
    try {
      await browser.storage.local.set({ [STORAGE_KEYS.SESSION]: session });
    } catch (error) {
      log('[JP343] Fehler beim Speichern des Session-States:', error);
    }
  }

  // ==========================================================================
  // EXTENSION STATS: Lokale Stats unabhaengig vom Sync-Status
  // ==========================================================================

  async function loadStats(): Promise<ExtensionStats> {
    try {
      const result = await browser.storage.local.get(STORAGE_KEYS.STATS);
      return result[STORAGE_KEYS.STATS] || { ...DEFAULT_STATS };
    } catch {
      return { ...DEFAULT_STATS };
    }
  }

  // Stats aktualisieren wenn neuer PendingEntry gespeichert wird
  async function updateStats(entry: PendingEntry): Promise<void> {
    try {
      const stats = await loadStats();
      const entryDate = new Date(entry.date).toISOString().split('T')[0]; // '2026-02-20'
      const today = new Date().toISOString().split('T')[0];

      // Minuten addieren
      stats.totalMinutes += entry.duration_min;
      stats.dailyMinutes[entryDate] = (stats.dailyMinutes[entryDate] || 0) + entry.duration_min;

      // Streak berechnen
      if (stats.lastActiveDate !== today) {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        if (stats.lastActiveDate === yesterdayStr) {
          stats.currentStreak += 1;
        } else if (stats.lastActiveDate !== today) {
          stats.currentStreak = 1; // Reset
        }
        stats.lastActiveDate = today;
      }

      // Alte Eintraege bereinigen (> 90 Tage)
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 90);
      const cutoffStr = cutoff.toISOString().split('T')[0];
      for (const dateKey of Object.keys(stats.dailyMinutes)) {
        if (dateKey < cutoffStr) {
          delete stats.dailyMinutes[dateKey];
        }
      }

      await browser.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
      log('[JP343] Stats aktualisiert: total=' + Math.round(stats.totalMinutes) + 'm, streak=' + stats.currentStreak);
    } catch (error) {
      log('[JP343] Fehler beim Aktualisieren der Stats:', error);
    }
  }

  // Streak aus dailyMinutes neu berechnen (nach Loeschung)
  function recalculateStreak(dailyMinutes: Record<string, number>): number {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let streak = 0;
    const checkDate = new Date(today);

    // Von heute rueckwaerts pruefen ob jeder Tag Minuten hat
    for (let i = 0; i < 365; i++) {
      const dateStr = checkDate.toISOString().split('T')[0];
      if ((dailyMinutes[dateStr] || 0) > 0) {
        streak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else if (i === 0) {
        // Heute noch keine Minuten → gestern pruefen (Streak kann trotzdem laufen)
        checkDate.setDate(checkDate.getDate() - 1);
        continue;
      } else {
        break;
      }
    }
    return streak;
  }

  // Stats reduzieren wenn unsynced Entry geloescht wird
  async function subtractFromStats(entry: PendingEntry): Promise<void> {
    try {
      const stats = await loadStats();
      const entryDate = new Date(entry.date).toISOString().split('T')[0];

      // Minuten abziehen (nie unter 0)
      stats.totalMinutes = Math.max(0, stats.totalMinutes - entry.duration_min);
      if (stats.dailyMinutes[entryDate]) {
        stats.dailyMinutes[entryDate] = Math.max(0, stats.dailyMinutes[entryDate] - entry.duration_min);
        // Key loeschen wenn 0
        if (stats.dailyMinutes[entryDate] <= 0) {
          delete stats.dailyMinutes[entryDate];
        }
      }

      // Streak neu berechnen (koennte durch Loeschung brechen)
      stats.currentStreak = recalculateStreak(stats.dailyMinutes);

      // lastActiveDate aktualisieren
      const dates = Object.keys(stats.dailyMinutes).sort();
      stats.lastActiveDate = dates.length > 0 ? dates[dates.length - 1] : '';

      await browser.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
      log('[JP343] Stats nach Loeschung: total=' + Math.round(stats.totalMinutes) + 'm, streak=' + stats.currentStreak);
    } catch (error) {
      log('[JP343] Fehler beim Subtrahieren der Stats:', error);
    }
  }

  // ==========================================================================
  // STATUS INDICATOR: Visuelles Feedback auf Extension-Icon
  // ==========================================================================

  // MV2/MV3 Kompatibilitaet: Firefox MV2 nutzt browserAction, Chrome MV3 nutzt action
  const badgeApi = browser.action ?? browser.browserAction;

  type TrackingStatus = 'recording' | 'paused' | 'ad' | 'idle';

  // Aktuellen Status ermitteln
  function getCurrentStatus(): TrackingStatus {
    // Ad-Check ZUERST: Bei Pre-Roll Ads gibt es noch keine Session,
    // aber der Ad-State ist trotzdem aktiv
    if (tracker.isAdPlaying()) return 'ad';
    const session = tracker.getCurrentSession();
    if (!session) return 'idle';
    if (session.isPaused) return 'paused';
    if (session.isActive) return 'recording';
    return 'idle';
  }

  // Badge-Update debounced (Fix Iteration 6: verhindert 3-5 Badge-Updates bei Navigation)
  let badgeUpdateTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleStatusBadgeUpdate(): void {
    if (badgeUpdateTimer) return;
    badgeUpdateTimer = setTimeout(async () => {
      badgeUpdateTimer = null;
      await _doUpdateStatusBadge();
    }, 500);
  }

  // Badge basierend auf Status und Pending-Count aktualisieren
  async function _doUpdateStatusBadge(): Promise<void> {
    // Pruefen ob Tracking aktiviert ist
    const settings = await loadSettings();
    if (!settings.enabled) {
      badgeApi.setBadgeText({ text: 'OFF' });
      badgeApi.setBadgeBackgroundColor({ color: '#6b7280' }); // Gray
      badgeApi.setTitle({ title: 'jp343 - Tracking disabled' });
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
        badgeApi.setTitle({ title: 'jp343 - Recording...' });
        break;

      case 'paused':
        // Orange mit Pause-Symbol
        badgeApi.setBadgeText({ text: '❚❚' });
        badgeApi.setBadgeBackgroundColor({ color: '#f59e0b' }); // Amber
        badgeApi.setTitle({ title: 'jp343 - Paused' });
        break;

      case 'ad':
        // Grau waehrend Werbung
        badgeApi.setBadgeText({ text: 'AD' });
        badgeApi.setBadgeBackgroundColor({ color: '#6b7280' }); // Gray
        badgeApi.setTitle({ title: 'jp343 - Ad playing (not tracking)' });
        break;

      case 'idle':
      default:
        // Idle: Zeige Pending-Count oder nichts
        if (unsyncedCount > 0) {
          badgeApi.setBadgeText({ text: String(unsyncedCount) });
          badgeApi.setBadgeBackgroundColor({ color: '#875aff' }); // JP343 accent
          badgeApi.setTitle({ title: `jp343 - ${unsyncedCount} pending entries` });
        } else {
          badgeApi.setBadgeText({ text: '' });
          badgeApi.setTitle({ title: 'jp343 Streaming Tracker' });
        }
        break;
    }
  }

  // Legacy-Funktion fuer Kompatibilitaet
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

          // WICHTIG: Vorherige Session speichern falls vorhanden und andere URL
          // Bei Episode-Wechsel kommt VIDEO_PLAY fuer neue Episode BEVOR VIDEO_ENDED fuer alte
          const currentSession = tracker.getCurrentSession();
          if (currentSession && currentSession.url !== message.state.url) {
            const previousEntry = tracker.finalizeSession();
            if (previousEntry) {
              await savePendingEntry(previousEntry);
              log('[JP343] Vorherige Session gespeichert bei Video-Wechsel:', previousEntry.project, previousEntry.duration_min, 'min');
            }
          }

          // Thumbnail-Carry-Over: Wenn neue Session kein Thumbnail hat,
          // vom letzten Entry mit gleicher project_id uebernehmen
          if (!message.state.thumbnailUrl) {
            const pending = await loadPendingEntries();
            // Neueste zuerst (letztes Element = neuestes)
            for (let i = pending.length - 1; i >= 0; i--) {
              if (pending[i].thumbnail && pending[i].url === message.state.url) {
                message.state.thumbnailUrl = pending[i].thumbnail;
                log('[JP343] Thumbnail von vorherigem Entry uebernommen');
                break;
              }
            }
          }

          // TabId aus Message oder Sender extrahieren
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
          // Titel nur aktualisieren wenn nicht manuell bearbeitet
          if (message.state.title) {
            tracker.updateSessionTitleFromAutoFetch(message.state.title);
          }

          // Channel-Info aktualisieren wenn vorher null (Race Condition Fix)
          if (message.state.channelName) {
            tracker.updateSessionChannelInfo(
              message.state.channelId || null,
              message.state.channelName,
              message.state.channelUrl || null
            );
          }

          // Thumbnail aktualisieren wenn vorher null (Race Condition Fix - z.B. Crunchyroll iframe)
          if (message.state.thumbnailUrl) {
            tracker.updateSessionThumbnail(message.state.thumbnailUrl);
          }

          // Channel-Block Check: Falls Channel erst jetzt bekannt wird (Fix 9)
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
        // Video im Tab pausieren bevor Session gestoppt wird
        const sessionBeforeStop = tracker.getCurrentSession();
        if (sessionBeforeStop?.tabId) {
          try {
            await browser.tabs.sendMessage(sessionBeforeStop.tabId, { type: 'PAUSE_VIDEO' });
          } catch { /* Tab existiert evtl. nicht mehr */ }
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
        // Video im Tab pausieren
        const sessionToPause = tracker.getCurrentSession();
        if (sessionToPause?.tabId) {
          try {
            await browser.tabs.sendMessage(sessionToPause.tabId, { type: 'PAUSE_VIDEO' });
          } catch { /* Tab existiert evtl. nicht mehr — manuelles Tracking hat kein Video */ }
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
        // Video im Tab fortsetzen
        if (resumedSession?.tabId) {
          try {
            await browser.tabs.sendMessage(resumedSession.tabId, { type: 'RESUME_VIDEO' });
          } catch { /* Tab existiert evtl. nicht mehr */ }
        }
        await saveSessionState(resumedSession);
        scheduleStatusBadgeUpdate();
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
        // Legacy: Popup nutzt jetzt SYNC_ENTRIES_DIRECT
        const pending = await loadPendingEntries();
        return {
          success: true,
          data: { pendingCount: pending.length }
        };
      }

      case 'SYNC_ENTRIES_DIRECT': {
        // Direct Sync via Background Service Worker (kein Bridge noetig)
        const result = await syncEntriesDirect();
        return { success: true, data: result };
      }

      case 'OPEN_DASHBOARD': {
        // Dashboard-Tab oeffnen (aus anderen Kontexten)
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
            // Entry finden BEVOR es geloescht wird (fuer Stats-Subtraktion)
            const deletedEntry = pending.find(e => e.id === message.entryId);
            const filtered = pending.filter(e => e.id !== message.entryId);
            await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: filtered });
            // Badge nur fuer unsynced entries
            const unsyncedCount = filtered.filter(e => !e.synced).length;
            updateBadge(unsyncedCount);
            // Stats immer anpassen — User erwartet "Löschen = Stunden weg"
            if (deletedEntry) {
              await subtractFromStats(deletedEntry);
            }
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
            // Badge nur fuer unsynced entries
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

          // Badge-Anzeige aktualisieren wenn deaktiviert
          if (!message.enabled) {
            // Laufende Session finalisieren und als Pending speichern
            const entry = tracker.finalizeSession();
            if (entry) {
              await savePendingEntry(entry);
              log('[JP343] Aktive Session finalisiert bei Deaktivierung');
            }
            await saveSessionState(null);

            badgeApi.setBadgeText({ text: 'OFF' });
            badgeApi.setBadgeBackgroundColor({ color: '#6b7280' }); // Gray
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
          // Pruefen ob bereits blockiert
          if (!settings.blockedChannels.some(c => c.channelId === message.channel.channelId)) {
            settings.blockedChannels.push(message.channel);
            await saveSettings(settings);
            log('[JP343] Kanal blockiert:', message.channel.channelName);
          }

          // Aktive Session stoppen wenn der geblockte Kanal gerade getrackt wird
          const currentSession = tracker.getCurrentSession();
          if (currentSession && currentSession.channelId === message.channel.channelId) {
            log('[JP343] Aktive Session fuer geblockten Kanal gestoppt:', message.channel.channelName);
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
          log('[JP343] Kanal entblockiert:', message.channelId);
          return { success: true, removed: before > settings.blockedChannels.length };
        }
        return { success: false, error: 'No channelId provided' };
      }

      case 'GET_CURRENT_CHANNEL': {
        // Aktuellen Kanal aus laufender Session holen
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
        // Titel der laufenden Session aktualisieren
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
        // Titel eines pending Entries aktualisieren
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
        // Aktiven Tab abfragen fuer Manual Tracking
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];
        if (!tab || !tab.url || !tab.id) {
          return { success: false, error: 'No active tab' };
        }

        // Extension-Seiten und spezielle URLs ausschliessen
        if (tab.url.startsWith('chrome-extension://') ||
            tab.url.startsWith('moz-extension://') ||
            tab.url.startsWith('about:') ||
            tab.url.startsWith('chrome://') ||
            tab.url.startsWith('edge://')) {
          return { success: false, error: 'Cannot track browser pages' };
        }

        // Streaming-Seiten erkennen (dort laeuft automatisches Tracking)
        // Prueft die Domain, nicht nur /watch/ - Katalog-Seiten gehoeren auch dazu
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

        // Vorherige Session speichern falls vorhanden
        const currentSession = tracker.getCurrentSession();
        if (currentSession) {
          const previousEntry = tracker.finalizeSession();
          if (previousEntry) {
            await savePendingEntry(previousEntry);
            log('[JP343] Vorherige Session gespeichert:', previousEntry.project);
          }
        }

        // VideoState fuer manuelles Tracking erstellen
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

      case 'GET_STATS': {
        const stats = await loadStats();

        // Wochen-Summe berechnen (aktuelle Kalenderwoche Mo-So)
        const now = new Date();
        const dayOfWeek = now.getDay(); // 0=So, 1=Mo...
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

        // Streak validieren (falls letzter Tag > gestern, reset)
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
        log('[JP343] Stats zurueckgesetzt');
        return { success: true };
      }

      default:
        return { success: false, error: 'Unknown message type' };
    }
    } catch (error) {
      log('[JP343] Fehler in handleMessage:', message.type, error);
      return { success: false, error: 'Internal error' };
    }
  }

  const MAX_RESTORE_AGE_MS = 4 * 60 * 60 * 1000; // 4 Stunden

  // Type-Guard fuer gespeicherte Sessions (Fix 8)
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

  // Session Recovery beim Start — rettet Tracking-Daten nach Browser-Crash/Shutdown
  // oder stellt Session wieder her wenn Service Worker nur kurz weg war
  async function recoverSession(): Promise<void> {
    try {
    const result = await browser.storage.local.get(STORAGE_KEYS.SESSION);
    const savedSession = result[STORAGE_KEYS.SESSION];

    if (!savedSession) return;

    // Validierung: Ungueltige Sessions verwerfen (Fix 8)
    if (!isValidSavedSession(savedSession)) {
      log('[JP343] Recovery: Ungueltige Session-Daten, wird verworfen');
      await saveSessionState(null);
      return;
    }

    const sessionAge = Date.now() - savedSession.lastUpdate;

    // Session < 4h alt → in Tracker wiederherstellen (SW war nur kurz weg)
    // Session bleibt in Storage als Backup
    if (sessionAge < MAX_RESTORE_AGE_MS) {
      tracker.restoreSession(savedSession);
      log('[JP343] Recovery: Session wiederhergestellt (Alter:', Math.round(sessionAge / 1000), 's)');
      scheduleStatusBadgeUpdate();
      return;
    }

    // Session >= 4h alt → Finalisieren (genuiner Crash/Orphan)
    // Minimum 1 Minute akkumuliert — sonst verwerfen
    if (savedSession.accumulatedMs < 60000) {
      log('[JP343] Recovery: Session zu kurz (<1min), wird verworfen');
      await saveSessionState(null);
      return;
    }

    // Float-Minuten fuer Sekunden-Praezision (z.B. 1.33 = 80 Sekunden)
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
      log('[JP343] Fehler bei Session Recovery:', error);
      await saveSessionState(null);
    }
  }

  recoverSession();

  // Alarm fuer periodische Aufgaben (optional)
  browser.alarms.create('jp343-check', { periodInMinutes: 5 });

  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'jp343-check') {
      // Laufende Session periodisch in Storage sichern (Crash-Recovery)
      const session = tracker.getCurrentSession();
      if (session) {
        await saveSessionState(session);
        log('[JP343] Periodic save - Session gesichert:', session.title, Math.round(session.accumulatedMs / 1000), 's');

        // Stale-Cleanup: Wiederhergestellte Session die zu lange pausiert ist finalisieren
        if (session.isPaused && (Date.now() - session.lastUpdate) > MAX_RESTORE_AGE_MS) {
          log('[JP343] Stale Session erkannt (>4h pausiert) - finalisiere');
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

  // ==========================================================================
  // AUTO-SAVE: Tab geschlossen oder Navigation weg von Streaming-Seite
  // ==========================================================================

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
      // Manuelles Tracking: Nur stoppen wenn Domain wechselt
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
          // Gleiche Domain - Session laeuft weiter, URL aktualisieren
          tracker.updateSessionUrl(changeInfo.url);
          const updatedSession = tracker.getCurrentSession();
          await saveSessionState(updatedSession);
          log('[JP343] Navigation innerhalb Domain - Session laeuft weiter');
        }
      } catch {
        // URL-Parsing fehlgeschlagen - sicherheitshalber Session beenden
        const entry = tracker.finalizeSession();
        if (entry) {
          await savePendingEntry(entry);
        }
        await saveSessionState(null);
        scheduleStatusBadgeUpdate();
      }
    } else {
      // Streaming-Seiten: Pruefen ob noch auf der GLEICHEN Plattform
      // Nur gleiche Plattform → Content Script kuemmert sich (SPA-Navigation)
      // Andere Plattform oder weg → Session beenden
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
