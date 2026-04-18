import type { ActivityType, ExtensionMessage, VideoState } from '../../types';
import { loadPendingEntries } from '../pending-entries';
import { tracker } from '../time-tracker';
import { scheduleStatusBadgeUpdate } from '../badge-service';
import type { BackgroundMessageContext } from './message-context';

export async function handleTrackingMessage(
  message: ExtensionMessage,
  messageSender: browser.Runtime.MessageSender,
  context: BackgroundMessageContext
): Promise<unknown> {
  switch (message.type) {
    case 'VIDEO_PLAY': {
      const settings = await context.loadSettings();
      if (!settings.enabled) {
        context.log('[JP343] Tracking disabled - ignoring VIDEO_PLAY');
        return { success: true, skipped: true };
      }

      if ('state' in message && message.state && typeof message.state === 'object') {
        const channelId = message.state.channelId;
        if (channelId && settings.blockedChannels.some(c => c.channelId === channelId)) {
          context.log('[JP343] Channel blocked - ignoring VIDEO_PLAY:', channelId);
          return { success: true, skipped: true, blocked: true };
        }

        if (message.state.platform === 'spotify' && message.state.contentType) {
          if (!settings.spotifyContentTypes?.includes(message.state.contentType)) {
            context.log('[JP343] Spotify content type blocked:', message.state.contentType);
            return { success: true, skipped: true, blocked: true };
          }
        }

        const currentSession = tracker.getCurrentSession();
        if (currentSession && currentSession.url !== message.state.url) {
          const previousEntry = tracker.finalizeSession();
          if (previousEntry) {
            await context.savePendingEntry(previousEntry);
            context.log('[JP343] Previous session saved on video switch:', previousEntry.project, previousEntry.duration_min, 'min');
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

        const tabId = ('tabId' in message ? message.tabId : undefined) || messageSender.tab?.id;
        const session = tracker.startSession(message.state, tabId);
        await context.saveSessionState(session);
        scheduleStatusBadgeUpdate();
      }
      return { success: true };
    }

    case 'VIDEO_PAUSE': {
      tracker.pauseSession();
      const session = tracker.getCurrentSession();
      await context.saveSessionState(session);
      scheduleStatusBadgeUpdate();
      return { success: true };
    }

    case 'VIDEO_ENDED': {
      const entry = tracker.finalizeSession();
      if (entry) {
        await context.savePendingEntry(entry);
      }
      await context.saveSessionState(null);
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
          const settings = await context.loadSettings();
          if (settings.blockedChannels.some(c => c.channelId === message.state.channelId)) {
            context.log('[JP343] Channel blocked on STATE_UPDATE - stopping session:', message.state.channelId);
            tracker.stopSession();
            await context.saveSessionState(null);
            scheduleStatusBadgeUpdate();
            return { success: true, blocked: true };
          }
        }
      }
      const session = tracker.getCurrentSession();
      await context.saveSessionState(session);
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
        } catch { /* ignore */ }
      }
      const entry = tracker.stopSession();
      if (entry) {
        await context.savePendingEntry(entry);
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
        /open\.spotify\.com/
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
