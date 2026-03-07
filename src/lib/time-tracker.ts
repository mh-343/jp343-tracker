// =============================================================================
// JP343 Extension - Time Tracker Logik
// Zentrale Klasse fuer Session-Management und Zeiterfassung
// =============================================================================

import type { TrackingSession, VideoState, PendingEntry, Platform } from '../types';

const DEBUG_MODE = import.meta.env.DEV;
const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};

// Generiert eindeutige Extension-IDs
function generateId(): string {
  return `ext_${crypto.randomUUID()}`;
}

// Generiert eine konsistente Project-ID basierend auf Video-Infos
function generateProjectId(platform: Platform, title: string, videoId: string | null): string {
  // Normalisiere Titel fuer konsistente IDs
  const normalized = title
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 30);

  if (videoId) {
    return `ext_${platform}_${videoId}`;
  }
  return `ext_${platform}_${normalized}`;
}

export class TimeTracker {
  private session: TrackingSession | null = null;
  private isInAd: boolean = false;
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Tick alle Sekunde um akkumulierte Zeit zu berechnen
    this.tickInterval = setInterval(() => this.tick(), 1000);
  }

  // Startet neue Session oder setzt bestehende fort
  startSession(videoState: VideoState, tabId?: number): TrackingSession {
    const now = Date.now();

    // Gleiche URL? Session fortsetzen
    if (this.session && this.session.url === videoState.url) {
      this.session.isActive = true;
      this.session.isPaused = false;
      this.session.lastUpdate = now;
      // TabId aktualisieren falls neu
      if (tabId) this.session.tabId = tabId;

      // Channel-Info aktualisieren: gleiche erweiterte Logik wie updateSessionChannelInfo
      const hadNoChId = this.session.channelId === null;
      const chIdChanged = videoState.channelId && !hadNoChId && this.session.channelId !== videoState.channelId;
      const gotChId = videoState.channelId && hadNoChId;
      const chNameCorrection = !videoState.channelId && hadNoChId
        && videoState.channelName && this.session.channelName
        && videoState.channelName !== this.session.channelName;
      if (videoState.channelName && (this.session.channelName === null || chIdChanged || gotChId || chNameCorrection)) {
        this.session.channelId = videoState.channelId || null;
        this.session.channelName = videoState.channelName;
        this.session.channelUrl = videoState.channelUrl || null;
        const reason = chIdChanged ? '(korrigiert)' : gotChId ? '(ID nachgeliefert)' : chNameCorrection ? '(Name korrigiert)' : '(initial)';
        log('[JP343] Channel bei Session-Fortsetzung aktualisiert:', videoState.channelName, reason);
      }

      // Thumbnail aktualisieren wenn vorher null (Race Condition Fix - z.B. Crunchyroll iframe)
      if (this.session.thumbnailUrl === null && videoState.thumbnailUrl) {
        this.session.thumbnailUrl = videoState.thumbnailUrl;
        log('[JP343] Thumbnail bei Session-Fortsetzung aktualisiert');
      }

      log('[JP343] Session fortgesetzt:', this.session.title);
      return this.session;
    }

    // Neue Session starten (alte finalisieren falls vorhanden)
    if (this.session) {
      this.finalizeSession();
    }

    this.session = {
      id: generateId(),
      platform: videoState.platform,
      title: videoState.title,
      url: videoState.url,
      videoId: videoState.videoId,
      tabId: tabId || null,
      startTime: now,
      accumulatedMs: 0,
      lastUpdate: now,
      isActive: true,
      isPaused: false,
      thumbnailUrl: videoState.thumbnailUrl,
      // Channel-Informationen
      channelId: videoState.channelId || null,
      channelName: videoState.channelName || null,
      channelUrl: videoState.channelUrl || null
    };

    log('[JP343] Neue Session gestartet:', this.session.title);
    return this.session;
  }

  // Pausiert die aktuelle Session
  pauseSession(): void {
    if (this.session && this.session.isActive) {
      this.tick(); // Letzte Zeit erfassen
      this.session.isActive = false;
      this.session.isPaused = true;
      log('[JP343] Session pausiert');
    }
  }

  // Setzt pausierte Session fort
  resumeSession(): void {
    if (this.session && this.session.isPaused) {
      this.session.isActive = true;
      this.session.isPaused = false;
      this.session.lastUpdate = Date.now();
      log('[JP343] Session fortgesetzt');
    }
  }

  // Session aus Storage wiederherstellen (nach Service Worker Restart)
  restoreSession(saved: TrackingSession): void {
    this.session = {
      ...saved,
      lastUpdate: Date.now()  // Reset fuer tick()-Delta
    };
    log('[JP343] Session wiederhergestellt:', saved.title, Math.round(saved.accumulatedMs / 1000), 's');
  }

  // Werbung erkannt - pausiert Tracking
  onAdStart(): void {
    if (!this.isInAd) {
      this.isInAd = true;
      log('[JP343] Werbung erkannt - Tracking pausiert');
    }
  }

  // Werbung beendet - Tracking fortsetzen
  onAdEnd(): void {
    if (this.isInAd) {
      this.isInAd = false;
      if (this.session) {
        this.session.lastUpdate = Date.now();
      }
      log('[JP343] Werbung beendet - Tracking fortgesetzt');
    }
  }

  // Wird jede Sekunde aufgerufen um Zeit zu akkumulieren
  private tick(): void {
    if (!this.session || !this.session.isActive || this.isInAd) {
      return;
    }

    const now = Date.now();
    const delta = now - this.session.lastUpdate;

    // Nur vernuenftige Deltas akzeptieren (max 5 Sekunden)
    // Verhindert Spruenge bei Tab-Wechsel etc.
    if (delta > 0 && delta < 5000) {
      this.session.accumulatedMs += delta;
    }

    this.session.lastUpdate = now;
  }

  // Finalisiert Session und erstellt PendingEntry
  finalizeSession(): PendingEntry | null {
    if (!this.session) {
      return null;
    }

    // Letzte Zeit erfassen
    this.tick();

    // Minimum 1 Minute - kuerzer wird verworfen
    if (this.session.accumulatedMs < 60000) {
      log('[JP343] Session zu kurz (<1min), wird verworfen');
      this.session = null;
      return null;
    }

    // Float-Minuten fuer Sekunden-Praezision (z.B. 1.33 = 80 Sekunden)
    const durationMinutes = this.session.accumulatedMs / 60000;

    const entry: PendingEntry = {
      id: this.session.id,
      date: new Date(this.session.startTime).toISOString(),
      duration_min: durationMinutes,
      project: this.session.title,
      project_id: generateProjectId(
        this.session.platform,
        this.session.title,
        this.session.videoId
      ),
      platform: this.session.platform,
      source: 'extension',
      url: this.session.url,
      thumbnail: this.session.thumbnailUrl,
      synced: false,
      syncedAt: null,
      syncAttempts: 0,
      lastSyncError: null,
      // Channel-Informationen (fuer Projekt-Zuordnung)
      channelId: this.session.channelId,
      channelName: this.session.channelName,
      channelUrl: this.session.channelUrl
    };

    log('[JP343] Session finalisiert:', durationMinutes, 'Minuten');

    this.session = null;
    return entry;
  }

  // Stoppt Session explizit (z.B. via Popup)
  stopSession(): PendingEntry | null {
    return this.finalizeSession();
  }

  // Gibt aktuelle Session zurueck (fuer Popup-Anzeige)
  getCurrentSession(): TrackingSession | null {
    return this.session;
  }

  // Gibt formatierte aktuelle Dauer zurueck
  getCurrentDuration(): string {
    if (!this.session) {
      return '0m';
    }

    // Live-Berechnung
    let totalMs = this.session.accumulatedMs;
    if (this.session.isActive && !this.isInAd) {
      totalMs += Date.now() - this.session.lastUpdate;
    }

    const totalSeconds = Math.floor(totalMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    } else {
      return `${seconds}s`;
    }
  }

  // Ist gerade in Werbung?
  isAdPlaying(): boolean {
    return this.isInAd;
  }

  // Titel der aktuellen Session aktualisieren (manuell vom User)
  updateSessionTitle(newTitle: string): boolean {
    if (!this.session) {
      return false;
    }
    this.session.title = newTitle;
    this.session.titleManuallyEdited = true; // Flag setzen - nicht ueberschreiben!
    log('[JP343] Session-Titel manuell geaendert:', newTitle);
    return true;
  }

  // Titel aus Auto-Fetch aktualisieren (nur wenn nicht manuell bearbeitet)
  updateSessionTitleFromAutoFetch(newTitle: string): boolean {
    if (!this.session) {
      return false;
    }
    // Nicht ueberschreiben wenn manuell bearbeitet
    if (this.session.titleManuallyEdited) {
      log('[JP343] Titel-Update ignoriert (manuell bearbeitet)');
      return false;
    }
    this.session.title = newTitle;
    return true;
  }

  // Pruefen ob Titel manuell bearbeitet wurde
  isTitleManuallyEdited(): boolean {
    return this.session?.titleManuallyEdited || false;
  }

  // Channel-Info nachtraeglich aktualisieren (wenn spaeter verfuegbar oder korrigiert)
  updateSessionChannelInfo(channelId: string | null, channelName: string | null, channelUrl: string | null): boolean {
    if (!this.session) return false;

    const hadNoChannelId = this.session.channelId === null;
    // channelId hat sich geaendert (Korrektur bei SPA-Navigation Race Condition)
    const channelIdChanged = channelId && !hadNoChannelId && this.session.channelId !== channelId;
    // YouTube-Fix: channelId wird nachgeliefert (war vorher null wegen SPA-Navigation Timing)
    const gotNewChannelId = channelId && hadNoChannelId;
    // Netflix/Crunchyroll-Fix: channelId ist IMMER null, aber channelName aendert sich
    // wenn User zwischen verschiedenen Serien wechselt und DOM stale war
    const nameOnlyCorrection = !channelId && hadNoChannelId
      && channelName && this.session.channelName
      && channelName !== this.session.channelName;

    if (channelName && (
      this.session.channelName === null
      || channelIdChanged
      || gotNewChannelId
      || nameOnlyCorrection
    )) {
      const reason = channelIdChanged ? '(ID korrigiert)'
        : gotNewChannelId ? '(ID nachgeliefert)'
        : nameOnlyCorrection ? '(Name korrigiert)'
        : '(initial)';
      this.session.channelId = channelId;
      this.session.channelName = channelName;
      this.session.channelUrl = channelUrl;
      log('[JP343] Channel-Info aktualisiert:', channelName, reason);
      return true;
    }
    return false;
  }

  // URL der aktuellen Session aktualisieren (z.B. bei Navigation innerhalb Domain)
  updateSessionUrl(newUrl: string): void {
    if (this.session) {
      this.session.url = newUrl;
    }
  }

  updateSessionThumbnail(thumbnailUrl: string): boolean {
    if (!this.session) return false;

    // Nur aktualisieren wenn aktuelle Session kein Thumbnail hat
    if (this.session.thumbnailUrl === null && thumbnailUrl) {
      this.session.thumbnailUrl = thumbnailUrl;
      log('[JP343] Thumbnail nachtraeglich gesetzt');
      return true;
    }
    return false;
  }

  // Cleanup
  destroy(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }
}

// Singleton-Instanz fuer Background Script
export const tracker = new TimeTracker();
