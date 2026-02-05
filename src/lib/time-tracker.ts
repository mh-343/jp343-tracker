// JP343 Extension - Time Tracker Logik

import type { TrackingSession, VideoState, PendingEntry, Platform } from '../types';

// Generiert eindeutige Extension-IDs
function generateId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 7);
  return `ext_${timestamp}_${random}`;
}

function generateProjectId(platform: Platform, title: string, videoId: string | null): string {
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
    this.tickInterval = setInterval(() => this.tick(), 1000);
  }

  startSession(videoState: VideoState, tabId?: number): TrackingSession {
    const now = Date.now();

    // Gleiche URL? Session fortsetzen
    if (this.session && this.session.url === videoState.url) {
      this.session.isActive = true;
      this.session.isPaused = false;
      this.session.lastUpdate = now;
      // TabId aktualisieren falls neu
      if (tabId) this.session.tabId = tabId;

      if (this.session.channelName === null && videoState.channelName) {
        this.session.channelId = videoState.channelId || null;
        this.session.channelName = videoState.channelName;
        this.session.channelUrl = videoState.channelUrl || null;
        console.log('[JP343] Channel bei Session-Fortsetzung aktualisiert:', videoState.channelName);
      }

      console.log('[JP343] Session fortgesetzt:', this.session.title);
      return this.session;
    }

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

    console.log('[JP343] Neue Session gestartet:', this.session.title);
    return this.session;
  }

  // Pausiert die aktuelle Session
  pauseSession(): void {
    if (this.session && this.session.isActive) {
      this.tick(); // Letzte Zeit erfassen
      this.session.isActive = false;
      this.session.isPaused = true;
      console.log('[JP343] Session pausiert');
    }
  }

  // Setzt pausierte Session fort
  resumeSession(): void {
    if (this.session && this.session.isPaused) {
      this.session.isActive = true;
      this.session.isPaused = false;
      this.session.lastUpdate = Date.now();
      console.log('[JP343] Session fortgesetzt');
    }
  }

  onAdStart(): void {
    if (!this.isInAd) {
      this.isInAd = true;
      console.log('[JP343] Werbung erkannt - Tracking pausiert');
    }
  }

  onAdEnd(): void {
    if (this.isInAd) {
      this.isInAd = false;
      if (this.session) {
        this.session.lastUpdate = Date.now();
      }
      console.log('[JP343] Werbung beendet - Tracking fortgesetzt');
    }
  }

  private tick(): void {
    if (!this.session || !this.session.isActive || this.isInAd) {
      return;
    }

    const now = Date.now();
    const delta = now - this.session.lastUpdate;

    // Verhindert Spruenge bei Tab-Wechsel etc.
    if (delta > 0 && delta < 5000) {
      this.session.accumulatedMs += delta;
    }

    this.session.lastUpdate = now;
  }

  finalizeSession(): PendingEntry | null {
    if (!this.session) {
      return null;
    }

    // Letzte Zeit erfassen
    this.tick();

    if (this.session.accumulatedMs < 30000) {
      console.log('[JP343] Session zu kurz (<30s), wird verworfen');
      this.session = null;
      return null;
    }

    const durationMinutes = Math.max(1, Math.round(this.session.accumulatedMs / 60000));

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
      channelId: this.session.channelId,
      channelName: this.session.channelName,
      channelUrl: this.session.channelUrl
    };

    console.log('[JP343] Session finalisiert:', durationMinutes, 'Minuten');

    this.session = null;
    return entry;
  }

  // Stoppt Session explizit (z.B. via Popup)
  stopSession(): PendingEntry | null {
    return this.finalizeSession();
  }

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

  isAdPlaying(): boolean {
    return this.isInAd;
  }

  updateSessionTitle(newTitle: string): boolean {
    if (!this.session) {
      return false;
    }
    this.session.title = newTitle;
    this.session.titleManuallyEdited = true;
    console.log('[JP343] Session-Titel manuell geaendert:', newTitle);
    return true;
  }

  updateSessionTitleFromAutoFetch(newTitle: string): boolean {
    if (!this.session) {
      return false;
    }
    if (this.session.titleManuallyEdited) {
      console.log('[JP343] Titel-Update ignoriert (manuell bearbeitet)');
      return false;
    }
    this.session.title = newTitle;
    return true;
  }

  isTitleManuallyEdited(): boolean {
    return this.session?.titleManuallyEdited || false;
  }

  updateSessionChannelInfo(channelId: string | null, channelName: string | null, channelUrl: string | null): boolean {
    if (!this.session) return false;

    // 1. Aktuelle Session hat keine Channel-Info (null)
    // 2. UND neue Channel-Info ist vorhanden
    if (this.session.channelName === null && channelName) {
      this.session.channelId = channelId;
      this.session.channelName = channelName;
      this.session.channelUrl = channelUrl;
      console.log('[JP343] Channel-Info nachtraeglich gesetzt:', channelName);
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

export const tracker = new TimeTracker();
