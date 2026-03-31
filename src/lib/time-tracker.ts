import type { TrackingSession, VideoState, PendingEntry, Platform, ActivityType } from '../types';
import { PLATFORM_ACTIVITY_TYPE } from '../types';

const DEBUG_MODE = import.meta.env.DEV;
const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};

function generateId(): string {
  return `ext_${crypto.randomUUID()}`;
}

export function generateProjectId(platform: Platform, title: string, videoId: string | null): string {
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

  startSession(videoState: VideoState, tabId?: number, activityTypeOverride?: ActivityType): TrackingSession {
    const now = Date.now();

    if (this.session && this.session.url === videoState.url) {
      this.session.isActive = true;
      this.session.isPaused = false;
      this.session.lastUpdate = now;
      if (tabId) this.session.tabId = tabId;

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
        const reason = chIdChanged ? '(corrected)' : gotChId ? '(ID late-delivered)' : chNameCorrection ? '(name corrected)' : '(initial)';
        log('[JP343] Channel updated on session resume:', videoState.channelName, reason);
      }

      if (this.session.thumbnailUrl === null && videoState.thumbnailUrl) {
        this.session.thumbnailUrl = videoState.thumbnailUrl;
        log('[JP343] Thumbnail updated on session resume');
      }

      log('[JP343] Session resumed:', this.session.title);
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
      channelId: videoState.channelId || null,
      channelName: videoState.channelName || null,
      channelUrl: videoState.channelUrl || null,
      activityType: activityTypeOverride ?? PLATFORM_ACTIVITY_TYPE[videoState.platform]
    };

    log('[JP343] New session started:', this.session.title);
    return this.session;
  }

  pauseSession(): void {
    if (this.session && this.session.isActive) {
      this.tick();
      this.session.isActive = false;
      this.session.isPaused = true;
      log('[JP343] Session paused');
    }
  }

  resumeSession(): void {
    if (this.session && this.session.isPaused) {
      this.session.isActive = true;
      this.session.isPaused = false;
      this.session.lastUpdate = Date.now();
      log('[JP343] Session resumed');
    }
  }

  restoreSession(saved: TrackingSession): void {
    this.session = {
      ...saved,
      lastUpdate: Date.now()
    };
    log('[JP343] Session restored:', saved.title, Math.round(saved.accumulatedMs / 1000), 's');
  }

  onAdStart(): void {
    if (!this.isInAd) {
      this.isInAd = true;
      log('[JP343] Ad detected - tracking paused');
    }
  }

  onAdEnd(): void {
    if (this.isInAd) {
      this.isInAd = false;
      if (this.session) {
        this.session.lastUpdate = Date.now();
      }
      log('[JP343] Ad ended - tracking resumed');
    }
  }

  private tick(): void {
    if (!this.session || !this.session.isActive || this.isInAd) {
      return;
    }

    const now = Date.now();
    const delta = now - this.session.lastUpdate;

    if (delta > 0 && delta < 5000) {
      this.session.accumulatedMs += delta;
    }

    this.session.lastUpdate = now;
  }

  finalizeSession(): PendingEntry | null {
    if (!this.session) {
      return null;
    }

    this.tick();

    if (this.session.accumulatedMs < 60000) {
      log('[JP343] Session too short (<1min), discarded');
      this.session = null;
      return null;
    }

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
      channelId: this.session.channelId,
      channelName: this.session.channelName,
      channelUrl: this.session.channelUrl,
      activityType: this.session.activityType
    };

    log('[JP343] Session finalized:', durationMinutes, 'minutes');

    this.session = null;
    return entry;
  }

  stopSession(): PendingEntry | null {
    return this.finalizeSession();
  }

  getCurrentSession(): TrackingSession | null {
    return this.session;
  }

  getCurrentDuration(): string {
    if (!this.session) {
      return '0m';
    }

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
    log('[JP343] Session title manually changed:', newTitle);
    return true;
  }

  updateSessionTitleFromAutoFetch(newTitle: string): boolean {
    if (!this.session) {
      return false;
    }
    if (this.session.titleManuallyEdited) {
      log('[JP343] Title update ignored (manually edited)');
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

    const hadNoChannelId = this.session.channelId === null;
    const channelIdChanged = channelId && !hadNoChannelId && this.session.channelId !== channelId;
    const gotNewChannelId = channelId && hadNoChannelId;
    const nameOnlyCorrection = !channelId && hadNoChannelId
      && channelName && this.session.channelName
      && channelName !== this.session.channelName;

    if (channelName && (
      this.session.channelName === null
      || channelIdChanged
      || gotNewChannelId
      || nameOnlyCorrection
    )) {
      const reason = channelIdChanged ? '(ID corrected)'
        : gotNewChannelId ? '(ID late-delivered)'
        : nameOnlyCorrection ? '(name corrected)'
        : '(initial)';
      this.session.channelId = channelId;
      this.session.channelName = channelName;
      this.session.channelUrl = channelUrl;
      log('[JP343] Channel info updated:', channelName, reason);
      return true;
    }
    return false;
  }

  updateSessionUrl(newUrl: string): void {
    if (this.session) {
      this.session.url = newUrl;
    }
  }

  updateSessionThumbnail(thumbnailUrl: string): boolean {
    if (!this.session) return false;

    if (this.session.thumbnailUrl === null && thumbnailUrl) {
      this.session.thumbnailUrl = thumbnailUrl;
      log('[JP343] Thumbnail set retroactively');
      return true;
    }
    return false;
  }

  destroy(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }
}

export const tracker = new TimeTracker();
