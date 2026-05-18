import type { ExtensionMessage, ExtensionSettings } from '../../types';
import { STORAGE_KEYS } from '../../types';
import {
  scheduleStatusBadgeUpdate,
  updateStatusBadge,
} from '../badge-service';
import { isJapaneseContent } from '../language-detection';
import { fetchAndCacheServerSessions, clearCachedServerSessions } from '../server-sessions';
import { tracker } from '../time-tracker';
import type { BackgroundMessageContext } from './message-context';

export async function handleSettingsMessage(
  message: ExtensionMessage,
  messageSender: Browser.runtime.MessageSender,
  context: BackgroundMessageContext
): Promise<unknown> {
  await context.recoveryReady;
  switch (message.type) {
    case 'JP343_SITE_LOADED': {
      const senderUrl = messageSender?.url || messageSender?.tab?.url || '';
      if (!/^https?:\/\/(.*\.)?jp343\.com(\/|$)/i.test(senderUrl) && !senderUrl.startsWith(browser.runtime.getURL(''))) {
        return { success: false, error: 'Unauthorized origin' };
      }
      if ('userState' in message) {
        const newState = message.userState;
        const existing = (await browser.storage.local.get(STORAGE_KEYS.USER))[STORAGE_KEYS.USER] ?? null;
        const merged = {
          ...newState,
          extApiToken: newState?.extApiToken || existing?.extApiToken || null,
          userId: newState?.userId || (existing?.userId ?? null),
          avatarUrlSmall: newState?.avatarUrlSmall
            ? newState.avatarUrlSmall
            : newState?.isLoggedIn
              ? null
              : (existing?.avatarUrlSmall ?? null),
        };
        if (!merged.isLoggedIn && merged.extApiToken) {
          merged.isLoggedIn = true;
        }
        await browser.storage.local.set({ [STORAGE_KEYS.USER]: merged });
        if (newState?.isLoggedIn && !newState?.avatarUrlSmall && existing?.avatarUrlSmall) {
          await browser.storage.local.remove([STORAGE_KEYS.AVATAR_DATA, STORAGE_KEYS.AVATAR_USER_ID]);
        }
        if ('displayName' in message && message.displayName) {
          await browser.storage.local.set({ [STORAGE_KEYS.DISPLAY_NAME]: message.displayName });
        }
        const identityChanged = existing?.userId && merged.userId && existing.userId !== merged.userId;
        context.log('[JP343] User state updated:', merged.isLoggedIn);
        if (merged.isLoggedIn && merged.extApiToken) {
          if (identityChanged) clearCachedServerSessions().catch(() => {});
          await context.pullAndMergeSettingsFromServer().catch(() => {});
          context.fetchAndCacheServerStats();
          fetchAndCacheServerSessions().catch(() => {});
        } else if (!merged.isLoggedIn) {
          clearCachedServerSessions().catch(() => {});
        }
      }
      return { success: true };
    }

    case 'GET_SETTINGS': {
      await context.ensureFreshSettings();
      const settings = await context.loadSettings();
      return { success: true, data: { settings } };
    }

    case 'UPDATE_SETTINGS': {
      if ('settings' in message && message.settings) {
        const newSettings = message.settings as ExtensionSettings;
        delete (newSettings as Record<string, unknown>).blockedChannels;
        delete (newSettings as Record<string, unknown>).whitelistedChannels;
        await context.saveSettings(newSettings);
        context.syncSettingsToServer(newSettings).catch(() => {});

        return { success: true };
      }
      return { success: false, error: 'No settings provided' };
    }

    case 'SET_ENABLED': {
      if ('enabled' in message) {
        const settings = await context.loadSettings();
        settings.enabled = message.enabled;
        await context.saveSettings(settings);

        if (!message.enabled) {
          const entry = tracker.finalizeSession();
          if (entry) {
            await context.savePendingEntry(entry);
            context.log('[JP343] Active session finalized on disable');
          }
          await context.saveSessionState(null);

          await updateStatusBadge();
        } else {
          scheduleStatusBadgeUpdate();
        }

        context.log('[JP343] Tracking', message.enabled ? 'enabled' : 'disabled');
        return { success: true };
      }
      return { success: false, error: 'No enabled value provided' };
    }

    case 'BLOCK_CHANNEL': {
      if ('channel' in message && message.channel) {
        await context.applyChannelOp({
          action: 'block',
          channelId: message.channel.channelId,
          channelName: message.channel.channelName,
          channelUrl: message.channel.channelUrl,
        });
        context.log('[JP343] Channel blocked:', message.channel.channelName);

        const currentSession = tracker.getCurrentSession();
        if (currentSession && currentSession.channelId === message.channel.channelId) {
          context.log('[JP343] Active session stopped for blocked channel:', message.channel.channelName);
          tracker.stopSession();
          await context.saveSessionState(null);
          scheduleStatusBadgeUpdate();
        }

        return { success: true };
      }
      return { success: false, error: 'No channel provided' };
    }

    case 'UNBLOCK_CHANNEL': {
      if ('channelId' in message && message.channelId) {
        await context.applyChannelOp({
          action: 'unblock',
          channelId: message.channelId,
          channelName: '',
          channelUrl: null,
        });
        context.log('[JP343] Channel unblocked:', message.channelId);
        return { success: true };
      }
      return { success: false, error: 'No channelId provided' };
    }

    case 'WHITELIST_CHANNEL': {
      if ('channel' in message && message.channel) {
        await context.applyChannelOp({
          action: 'whitelist',
          channelId: message.channel.channelId,
          channelName: message.channel.channelName,
          channelUrl: message.channel.channelUrl,
        });
        context.log('[JP343] Channel whitelisted:', message.channel.channelName);
        return { success: true };
      }
      return { success: false, error: 'No channel provided' };
    }

    case 'UNWHITELIST_CHANNEL': {
      if ('channelId' in message && message.channelId) {
        await context.applyChannelOp({
          action: 'unwhitelist',
          channelId: message.channelId,
          channelName: '',
          channelUrl: null,
        });
        context.log('[JP343] Channel unwhitelisted:', message.channelId);

        const settings = await context.loadSettings();
        if (settings.trackJapaneseOnly) {
          const currentSession = tracker.getCurrentSession();
          if (currentSession && currentSession.channelId === message.channelId) {
            const videoIsJp = isJapaneseContent(currentSession.title || '');
            if (!videoIsJp) {
              const entry = tracker.finalizeSession();
              if (entry) {
                await context.savePendingEntry(entry);
                context.log('[JP343] Session saved on un-whitelist:', entry.project, entry.duration_min, 'min');
              }
              context.setLastSkippedChannel({
                channelId: message.channelId,
                channelName: currentSession.channelName || message.channelId,
                channelUrl: currentSession.channelUrl || null
              });
              await context.saveSessionState(null);
              scheduleStatusBadgeUpdate();
            }
          }
        }

        return { success: true };
      }
      return { success: false, error: 'No channelId provided' };
    }

    case 'REFETCH_AVATAR': {
      const user = (await browser.storage.local.get(STORAGE_KEYS.USER))[STORAGE_KEYS.USER];
      if (user?.avatarUrlSmall && user?.userId) {
        context.fetchAndStoreAvatar(user.avatarUrlSmall, user.userId);
      }
      return { success: true };
    }

    case 'PULL_CHANNELS': {
      context.pullChannelsFromServer().catch(() => {});
      return { success: true };
    }

    default:
      return { success: false, error: 'Unknown message type' };
  }
}
