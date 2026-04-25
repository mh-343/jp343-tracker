import type { ExtensionMessage, ExtensionSettings } from '../../types';
import { STORAGE_KEYS } from '../../types';
import {
  scheduleStatusBadgeUpdate,
  updateStatusBadge,
} from '../badge-service';
import { tracker } from '../time-tracker';
import type { BackgroundMessageContext } from './message-context';

export async function handleSettingsMessage(
  message: ExtensionMessage,
  messageSender: browser.Runtime.MessageSender,
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
        };
        if (!merged.isLoggedIn && merged.extApiToken) {
          merged.isLoggedIn = true;
        }
        await browser.storage.local.set({ [STORAGE_KEYS.USER]: merged });
        if ('displayName' in message && message.displayName) {
          await browser.storage.local.set({ [STORAGE_KEYS.DISPLAY_NAME]: message.displayName });
        }
        context.log('[JP343] User state updated:', merged.isLoggedIn);
        if (merged.isLoggedIn && merged.extApiToken) {
          await context.pullAndMergeSettingsFromServer().catch(() => {});
          context.fetchAndCacheServerStats();
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
        const settings = await context.loadSettings();
        if (!settings.blockedChannels.some(c => c.channelId === message.channel.channelId)) {
          settings.blockedChannels.push(message.channel);
          await context.saveSettings(settings);
          context.log('[JP343] Channel blocked:', message.channel.channelName);
          context.syncSettingsToServer(settings).catch(() => {});
        }

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
        const settings = await context.loadSettings();
        const before = settings.blockedChannels.length;
        settings.blockedChannels = settings.blockedChannels.filter(
          c => c.channelId !== message.channelId
        );
        await context.saveSettings(settings);
        context.log('[JP343] Channel unblocked:', message.channelId);
        context.syncSettingsToServer(settings).catch(() => {});
        return { success: true, removed: before > settings.blockedChannels.length };
      }
      return { success: false, error: 'No channelId provided' };
    }

    default:
      return { success: false, error: 'Unknown message type' };
  }
}
