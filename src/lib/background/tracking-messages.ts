import type { ActivityType, ExtensionMessage, Platform, TrackingSession, VideoState } from '../../types';
import { loadPendingEntries } from '../pending-entries';
import { tracker } from '../time-tracker';
import { scheduleStatusBadgeUpdate } from '../badge-service';
import { isJapaneseContent, isLikelyJapaneseVideo } from '../language-detection';
import { fetchOembedTitle, isChannelInList } from '../youtube-utils';
import type { BackgroundMessageContext } from './message-context';

const jpCheckCache = new Map<string, boolean>();

function isJapaneseGatedPlatform(platform: Platform): boolean {
  return platform === 'youtube' || platform === 'twitch';
}

async function checkJapaneseVideo(state: VideoState): Promise<boolean> {
  if (isLikelyJapaneseVideo(state)) return true;
  if (!state.videoId || state.platform !== 'youtube') return false;
  if (jpCheckCache.has(state.videoId)) return jpCheckCache.get(state.videoId)!;
  try {
    const title = await fetchOembedTitle(state.videoId);
    const result = isJapaneseContent(title ?? '');
    jpCheckCache.set(state.videoId, result);
    return result;
  } catch {
    jpCheckCache.set(state.videoId, false);
    return false;
  }
}

async function collectUnflushedTime(
  session: TrackingSession,
  recordDiagnostic?: (code: string, platform?: string) => void
): Promise<void> {
  if (!session.tabId || session.platform === 'generic') return;
  try {
    const response = await browser.tabs.sendMessage(session.tabId, { type: 'GET_CONTENT_TIME' });
    if (response && typeof response.unflushedMs === 'number' && response.sessionId === session.id && response.unflushedMs > 0) {
      tracker.addDelta(response.unflushedMs);
      recordDiagnostic?.('unflushed_collected', session.platform);
    }
  } catch {
    recordDiagnostic?.('unflushed_failed', session.platform);
  }
}

export async function handleTrackingMessage(
  message: ExtensionMessage,
  messageSender: Browser.runtime.MessageSender,
  context: BackgroundMessageContext,
  recordDiagnostic?: (code: string, platform?: string) => void
): Promise<unknown> {
  await context.recoveryReady;
  const senderTabId = messageSender.tab?.id;
  const activeSession = tracker.getCurrentSession();
  const isWrongTab = activeSession && senderTabId && activeSession.tabId !== senderTabId;

  switch (message.type) {
    case 'VIDEO_PLAY': {
      const settings = await context.loadSettings();
      if (!settings.enabled) {
        context.log('[JP343] Tracking disabled - ignoring VIDEO_PLAY');
        return { success: true, skipped: true };
      }

      if ('state' in message && message.state && typeof message.state === 'object') {
        const channelId = message.state.channelId;
        if (channelId && isChannelInList(settings.blockedChannels, channelId, message.state.channelUrl)) {
          if (settings.trackJapaneseOnly && isJapaneseGatedPlatform(message.state.platform)) {
            context.setLastSkippedChannel({
              channelId,
              channelName: message.state.channelName || channelId,
              channelUrl: message.state.channelUrl
            });
          }
          context.log('[JP343] Channel blocked - ignoring VIDEO_PLAY:', channelId);
          return { success: true, skipped: true, blocked: true };
        }

        if (message.state.platform === 'spotify' && message.state.contentType) {
          if (!settings.spotifyContentTypes?.includes(message.state.contentType)) {
            context.log('[JP343] Spotify content type blocked:', message.state.contentType);
            return { success: true, skipped: true, blocked: true };
          }
        }

        if (
          settings.trackJapaneseOnly &&
          isJapaneseGatedPlatform(message.state.platform)
        ) {
          const isWhitelisted = channelId &&
            isChannelInList(settings.whitelistedChannels, channelId, message.state.channelUrl);
          if (!isWhitelisted && message.state.title) {
            const isJP = await checkJapaneseVideo(message.state);
            if (!isJP) {
              if (channelId) {
                context.setLastSkippedChannel({
                  channelId,
                  channelName: message.state.channelName || channelId,
                  channelUrl: message.state.channelUrl
                });
              }
              context.log('[JP343] Non-JP content skipped (track-only mode)');
              return { success: true, skipped: true };
            }
          }
        }

        const currentSession = tracker.getCurrentSession();
        if (currentSession && currentSession.url !== message.state.url) {
          await collectUnflushedTime(currentSession, recordDiagnostic);
          const previousEntry = tracker.finalizeSession();
          if (previousEntry) {
            await context.savePendingEntry(previousEntry);
            context.log('[JP343] Previous session saved on video switch:', previousEntry.project, previousEntry.duration_min, 'min');
          } else {
            recordDiagnostic?.('session_discarded', currentSession.platform);
          }
        }

        if (!message.state.thumbnailUrl) {
          const pending = await loadPendingEntries();
          for (let i = pending.length - 1; i >= 0; i--) {
            if (pending[i].thumbnail && pending[i].url === message.state.url) {
              message.state.thumbnailUrl = pending[i].thumbnail;
              context.log('[JP343] Thumbnail carried over from previous entry');
              break;
            }
          }
        }

        context.setLastSkippedChannel(null);
        const tabId = ('tabId' in message ? message.tabId : undefined) || messageSender.tab?.id;
        const session = tracker.startSession(message.state, tabId);
        await context.saveSessionState(session);
        scheduleStatusBadgeUpdate();
      }
      return { success: true, sessionId: tracker.getSessionId() };
    }

    case 'VIDEO_PAUSE': {
      if (isWrongTab) return { success: true };
      tracker.pauseSession();
      const session = tracker.getCurrentSession();
      await context.saveSessionState(session);
      scheduleStatusBadgeUpdate();
      return { success: true };
    }

    case 'VIDEO_ENDED': {
      if (isWrongTab) return { success: true };
      if ('state' in message && message.state?.channelName) {
        tracker.updateSessionChannelInfo(
          message.state.channelId || null,
          message.state.channelName,
          message.state.channelUrl || null
        );
      }
      const preSession = tracker.getCurrentSession();
      if (preSession) await collectUnflushedTime(preSession, recordDiagnostic);
      const entry = tracker.finalizeSession();
      if (entry) {
        await context.savePendingEntry(entry);
      } else if (preSession) {
        recordDiagnostic?.('session_discarded', preSession.platform);
      }
      await context.saveSessionState(null);
      scheduleStatusBadgeUpdate();
      return { success: true, saved: !!entry };
    }

    case 'AD_START': {
      if (isWrongTab) return { success: true };
      tracker.onAdStart();
      scheduleStatusBadgeUpdate();
      return { success: true };
    }

    case 'AD_END': {
      if (isWrongTab) return { success: true };
      tracker.onAdEnd();
      scheduleStatusBadgeUpdate();
      return { success: true };
    }

    case 'VIDEO_STATE_UPDATE': {
      if (isWrongTab) return { success: true };
      if ('state' in message && message.state && typeof message.state === 'object') {
        if (message.state.isPlaying) {
          const session = tracker.getCurrentSession();
          if (session && session.isPaused) {
            tracker.resumeSession();
            scheduleStatusBadgeUpdate();
            recordDiagnostic?.('heartbeat_resume', message.platform);
          }
        }
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

        if (message.state.channelId || message.state.title) {
          const settings = await context.loadSettings();
          if (message.state.channelId && isChannelInList(settings.blockedChannels, message.state.channelId, message.state.channelUrl)) {
            if (settings.trackJapaneseOnly && isJapaneseGatedPlatform(message.state.platform)) {
              context.setLastSkippedChannel({
                channelId: message.state.channelId,
                channelName: message.state.channelName || message.state.channelId,
                channelUrl: message.state.channelUrl || null
              });
            }
            context.log('[JP343] Channel blocked on STATE_UPDATE - stopping session:', message.state.channelId);
            const blockedSession = tracker.getCurrentSession();
            if (blockedSession) await collectUnflushedTime(blockedSession, recordDiagnostic);
            tracker.stopSession();
            await context.saveSessionState(null);
            scheduleStatusBadgeUpdate();
            return { success: true, blocked: true };
          }
          if (
            settings.trackJapaneseOnly &&
            isJapaneseGatedPlatform(message.state.platform) &&
            message.state.title
          ) {
            const chId = message.state.channelId;
            const isWhitelisted = chId &&
              isChannelInList(settings.whitelistedChannels, chId, message.state.channelUrl);
            if (!isWhitelisted) {
              const isJP = await checkJapaneseVideo(message.state);
              if (!isJP) {
                if (chId) {
                  context.setLastSkippedChannel({
                    channelId: chId,
                    channelName: message.state.channelName || chId,
                    channelUrl: message.state.channelUrl || null
                  });
                }
                context.log('[JP343] Non-JP title confirmed on STATE_UPDATE - stopping session');
                const nonJpSession = tracker.getCurrentSession();
                if (nonJpSession) await collectUnflushedTime(nonJpSession, recordDiagnostic);
                tracker.stopSession();
                await context.saveSessionState(null);
                scheduleStatusBadgeUpdate();
                return { success: true, skipped: true };
              }
            }
          }
        }

        if (
          !tracker.getCurrentSession() &&
          (message.state.originalTitle || message.state.audioLanguage) &&
          isJapaneseGatedPlatform(message.state.platform) &&
          message.state.isPlaying
        ) {
          const settings = await context.loadSettings();
          if (settings.trackJapaneseOnly) {
            const lastSkipped = context.getLastSkippedChannel();
            const chId = message.state.channelId;
            if (lastSkipped && chId && (lastSkipped.channelId === chId || (lastSkipped.channelUrl && message.state.channelUrl && lastSkipped.channelUrl === message.state.channelUrl))) {
              const isWhitelisted = isChannelInList(settings.whitelistedChannels, chId, message.state.channelUrl);
              if (!isWhitelisted) {
                const isJP = await checkJapaneseVideo(message.state);
                if (isJP) {
                  context.log('[JP343] Re-evaluation: original title is JP, starting session');
                  context.setLastSkippedChannel(null);
                  const tabId = ('tabId' in message ? message.tabId : undefined) || messageSender.tab?.id;
                  tracker.startSession(message.state as VideoState, tabId);
                  scheduleStatusBadgeUpdate();
                }
              }
            }
          }
        }
      }
      const session = tracker.getCurrentSession();
      await context.saveSessionState(session);
      return { success: true };
    }

    case 'TIME_DELTA': {
      if (isWrongTab) return { success: true };
      if ('deltaMs' in message && typeof message.deltaMs === 'number' && message.deltaMs > 0) {
        const session = tracker.getCurrentSession();
        if (!session) return { success: true };
        if ('sessionId' in message && message.sessionId !== session.id) return { success: true };
        if (session.isPaused) {
          tracker.resumeSession();
          recordDiagnostic?.('heartbeat_resume', message.platform);
        }
        tracker.addDelta(message.deltaMs);
        await context.saveSessionState(tracker.getCurrentSession());
        scheduleStatusBadgeUpdate();
      }
      return { success: true };
    }

    case 'GET_CURRENT_SESSION': {
      const session = tracker.getCurrentSession();
      const isAd = tracker.isAdPlaying();

      let durationMs = tracker.getCurrentDurationMs();

      if (session && session.tabId && session.platform !== 'generic') {
        try {
          const response = await browser.tabs.sendMessage(session.tabId, { type: 'GET_CONTENT_TIME' });
          if (response && typeof response.unflushedMs === 'number' && response.sessionId === session.id) {
            durationMs = session.accumulatedMs + response.unflushedMs;
            if (response.unflushedMs > 0 && session.isPaused) {
              tracker.resumeSession();
              recordDiagnostic?.('heartbeat_resume', session.platform);
            }
          }
        } catch { /* tab gone or content script not ready */ }
      }

      const duration = tracker.formatDurationFromMs(durationMs);

      let skippedChannel: { channelId: string; channelName: string; channelUrl: string | null; platform: 'youtube' } | null = null;
      if (!session) {
        const settings = await context.loadSettings();
        if (settings.trackJapaneseOnly) {
          const skipped = context.getLastSkippedChannel();
          if (skipped) {
            skippedChannel = {
              channelId: skipped.channelId,
              channelName: skipped.channelName,
              channelUrl: skipped.channelUrl,
              platform: 'youtube'
            };
          }
        }
      }

      return {
        success: true,
        data: { session, duration, durationMs, isAd, skippedChannel }
      };
    }

    case 'STOP_SESSION': {
      const sessionBeforeStop = tracker.getCurrentSession();
      if (sessionBeforeStop?.tabId) {
        try {
          await browser.tabs.sendMessage(sessionBeforeStop.tabId, { type: 'PAUSE_VIDEO' });
        } catch { /* ignore */ }
      }
      if (sessionBeforeStop) await collectUnflushedTime(sessionBeforeStop, recordDiagnostic);
      const entry = tracker.stopSession();
      if (entry) {
        await context.savePendingEntry(entry);
      } else if (sessionBeforeStop) {
        recordDiagnostic?.('session_discarded', sessionBeforeStop.platform);
      }
      await context.saveSessionState(null);
      scheduleStatusBadgeUpdate();
      return { success: true, saved: !!entry };
    }

    case 'PAUSE_SESSION': {
      const sessionToPause = tracker.getCurrentSession();
      if (sessionToPause?.tabId) {
        try {
          await browser.tabs.sendMessage(sessionToPause.tabId, { type: 'PAUSE_VIDEO' });
        } catch { /* ignore */ }
      }
      tracker.pauseSession();
      const pausedSession = tracker.getCurrentSession();
      await context.saveSessionState(pausedSession);
      scheduleStatusBadgeUpdate();
      return { success: true };
    }

    case 'RESUME_SESSION': {
      tracker.resumeSession();
      const resumedSession = tracker.getCurrentSession();
      if (resumedSession?.tabId) {
        try {
          await browser.tabs.sendMessage(resumedSession.tabId, { type: 'RESUME_VIDEO' });
        } catch { /* ignore */ }
      }
      await context.saveSessionState(resumedSession);
      scheduleStatusBadgeUpdate();
      return { success: true };
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
      const skipped = context.getLastSkippedChannel();
      if (skipped) {
        return {
          success: true,
          data: {
            channelId: skipped.channelId,
            channelName: skipped.channelName,
            channelUrl: skipped.channelUrl,
            platform: 'youtube' as const
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
          await context.saveSessionState(session);
          context.log('[JP343] Session title updated:', message.title);
          return { success: true };
        }
        return { success: false, error: 'No active session' };
      }
      return { success: false, error: 'No title provided' };
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
        /cijapanese\.com/,
        /nijapanese\.com/,
        /nihongo-jikan\.com/,
        /open\.spotify\.com/,
        /twitch\.tv/,
        /app\.asbplayer\.dev/
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
      const settings = await context.loadSettings();
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
          await context.savePendingEntry(previousEntry);
          context.log('[JP343] Previous session saved:', previousEntry.project);
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

      const session = tracker.startSession(manualState, message.tabId as number, message.activityType as ActivityType);
      await context.saveSessionState(session);
      scheduleStatusBadgeUpdate();

      context.log('[JP343] Manual tracking started:', message.title);
      return { success: true, data: { session } };
    }

    default:
      return { success: false, error: 'Unknown message type' };
  }
}
