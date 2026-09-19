import type { ExtensionMessage, Platform } from '../../types';
import type { BackgroundMessageContext } from './message-context';
import type { DiagnosticsContext } from './diagnostics-context';
import { handlePendingMessage } from './pending-messages';
import { handleSettingsMessage } from './settings-messages';
import { handleStatsSyncMessage } from './stats-sync-messages';
import { handleTrackingMessage } from './tracking-messages';
import { handleDiagnosticsMessage } from './diagnostics-messages';
import { handleMpchcMessage } from './mpchc-messages';
import { handleSyncMessage } from './sync-messages';
import { handleAnkiMessage } from './anki-messages';
import { handleReaderMessage } from './reader-messages';
import { handleCustomSitesMessage } from './custom-sites-messages';
import { handleDifficultyMapMessage, handleSaveLocalDifficultyBand, handleGetVoteState, handleSubmitDifficultyVote } from './difficulty-messages';

function getMessageType(message: unknown): string {
  if (!message || typeof message !== 'object') return 'unknown';
  const candidate = message as Record<string, unknown>;
  return typeof candidate.type === 'string' ? candidate.type : 'unknown';
}

const DASHBOARD_ONLY_MESSAGES = new Set(['COMMIT_EXTENSION_AUTH_STATE', 'DELETE_SERVER_ENTRY', 'RETAG_ENTRY', 'BULK_RETAG_UNTAGGED', 'SET_MPCHC_ENABLED', 'GET_MPCHC_STATUS', 'MPCHC_PROBE', 'IMPORT_PENDING_BACKUP']);

function isDashboardSender(messageSender: Browser.runtime.MessageSender): boolean {
  if (messageSender?.id !== browser.runtime.id) return false;
  const url = messageSender.url ?? '';
  const dashboardUrl = browser.runtime.getURL('/dashboard.html');
  if (url === dashboardUrl) return true;
  return url.startsWith(`${dashboardUrl}?`) || url.startsWith(`${dashboardUrl}#`);
}

function isSyncPageSender(messageSender: Browser.runtime.MessageSender): boolean {
  if (messageSender.id !== browser.runtime.id) return false;
  return (['/popup.html', '/dashboard.html'] as const).some(page => {
    const url = browser.runtime.getURL(page);
    return messageSender.url === url || messageSender.url?.startsWith(`${url}?`) || messageSender.url?.startsWith(`${url}#`);
  });
}

export function createBackgroundMessageHandler(
  context: BackgroundMessageContext,
  diagnosticsContext: DiagnosticsContext
) {
  return async function handleMessage(
    message: ExtensionMessage,
    messageSender: Browser.runtime.MessageSender
  ): Promise<unknown> {
    if (!message || typeof message.type !== 'string') {
      return { success: false, error: 'Invalid message format' };
    }
    if (DASHBOARD_ONLY_MESSAGES.has(message.type) && !isDashboardSender(messageSender)) {
      return { success: false, error: 'Unauthorized sender' };
    }
    if (['GET_SYNC_STATUS', 'RETRY_PENDING_SYNC', 'REMOVE_BLOCKED_SYNC_ENTRY'].includes(message.type) && !isSyncPageSender(messageSender)) {
      return { success: false, error: 'Unauthorized sender' };
    }

    try {
      switch (message.type) {
        case 'VIDEO_PLAY':
        case 'VIDEO_PAUSE':
        case 'VIDEO_ENDED':
        case 'AD_START':
        case 'AD_END':
        case 'VIDEO_STATE_UPDATE':
        case 'TIME_DELTA':
        case 'GET_CURRENT_SESSION':
        case 'STOP_SESSION':
        case 'PAUSE_SESSION':
        case 'RESUME_SESSION':
        case 'GET_CURRENT_CHANNEL':
        case 'UPDATE_SESSION_TITLE':
        case 'SET_SESSION_ATTENTION':
        case 'GET_ACTIVE_TAB_INFO':
        case 'MANUAL_TRACK_START':
          return handleTrackingMessage(message, messageSender, context,
            (code: string, platform?: string) => diagnosticsContext.recordDiagnosticEvent(code, platform as Platform));

        case 'GET_PENDING_ENTRIES':
        case 'DELETE_PENDING_ENTRY':
        case 'REMOVE_BLOCKED_SYNC_ENTRY':
        case 'DELETE_SERVER_ENTRY':
        case 'GET_DELETED_ENTRIES':
        case 'RESTORE_DELETED_ENTRY':
        case 'PURGE_DELETED_ENTRY':
        case 'CLEAR_SYNCED_ENTRIES':
        case 'UPDATE_PENDING_ENTRY_TITLE':
        case 'RETAG_ENTRY':
        case 'BULK_RETAG_UNTAGGED':
          return handlePendingMessage(message, context);

        case 'JP343_SITE_LOADED':
        case 'COMMIT_EXTENSION_AUTH_STATE':
        case 'GET_SETTINGS':
        case 'UPDATE_SETTINGS':
        case 'SET_ENABLED':
        case 'BLOCK_CHANNEL':
        case 'UNBLOCK_CHANNEL':
        case 'WHITELIST_CHANNEL':
        case 'UNWHITELIST_CHANNEL':
        case 'REFETCH_AVATAR':
        case 'PULL_CHANNELS':
          return handleSettingsMessage(message, messageSender, context);

        case 'SYNC_ENTRIES_DIRECT':
        case 'OPEN_DASHBOARD':
        case 'GET_STATS':
        case 'RESET_STATS':
          return handleStatsSyncMessage(message, context);

        case 'GET_SYNC_STATUS':
        case 'RETRY_PENDING_SYNC':
        case 'IMPORT_PENDING_BACKUP':
          return handleSyncMessage(message, context);

        case 'DIAGNOSTIC_EVENT':
        case 'GET_DIAGNOSTICS':
          return handleDiagnosticsMessage(message, diagnosticsContext);

        case 'SET_MPCHC_ENABLED':
        case 'GET_MPCHC_STATUS':
        case 'MPCHC_PROBE':
          await context.recoveryReady;
          return handleMpchcMessage(message);

        case 'GET_ANKI_STATE':
        case 'SET_ANKI_ENABLED':
        case 'ANKI_SYNC_NOW':
        case 'GET_ANKI_DECKS':
        case 'SET_ANKI_DECKS':
        case 'ANKI_FLUSH_AND_RESET':
        case 'ANKI_RESET':
          return handleAnkiMessage(message);

        case 'READER_GET_STATE':
        case 'READER_SET_ENABLED':
        case 'READER_SNAPSHOT':
          return handleReaderMessage(message, context);

        case 'CUSTOM_SITES_GET':
        case 'CUSTOM_SITE_ADD':
        case 'CUSTOM_SITE_REMOVE':
        case 'RENAME_CUSTOM_SITE_SERIES':
        case 'CUSTOM_SITE_NAME_RESET':
          return handleCustomSitesMessage(message, context);

        case 'GET_DIFFICULTY_MAP':
          return handleDifficultyMapMessage(context);

        case 'SAVE_LOCAL_DIFFICULTY_BAND':
          return handleSaveLocalDifficultyBand(message, context);

        case 'GET_VOTE_STATE':
          return handleGetVoteState(message, context);

        case 'SUBMIT_DIFFICULTY_VOTE':
          return handleSubmitDifficultyVote(message);

        default:
          return { success: false, error: 'Unknown message type' };
      }
    } catch (error) {
      context.log('[JP343] Error in handleMessage:', getMessageType(message), error);
      return { success: false, error: 'Internal error' };
    }
  };
}
