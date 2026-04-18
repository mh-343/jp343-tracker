import type { ExtensionMessage } from '../../types';
import type { BackgroundMessageContext } from './message-context';
import type { DiagnosticsContext } from './diagnostics-context';
import { handlePendingMessage } from './pending-messages';
import { handleSettingsMessage } from './settings-messages';
import { handleStatsSyncMessage } from './stats-sync-messages';
import { handleTrackingMessage } from './tracking-messages';
import { handleDiagnosticsMessage } from './diagnostics-messages';

function getMessageType(message: unknown): string {
  if (!message || typeof message !== 'object') return 'unknown';
  const candidate = message as Record<string, unknown>;
  return typeof candidate.type === 'string' ? candidate.type : 'unknown';
}

export function createBackgroundMessageHandler(
  context: BackgroundMessageContext,
  diagnosticsContext: DiagnosticsContext
) {
  return async function handleMessage(
    message: ExtensionMessage,
    messageSender: browser.Runtime.MessageSender
  ): Promise<unknown> {
    if (!message || typeof message.type !== 'string') {
      return { success: false, error: 'Invalid message format' };
    }

    try {
      switch (message.type) {
        case 'VIDEO_PLAY':
        case 'VIDEO_PAUSE':
        case 'VIDEO_ENDED':
        case 'AD_START':
        case 'AD_END':
        case 'VIDEO_STATE_UPDATE':
        case 'GET_CURRENT_SESSION':
        case 'STOP_SESSION':
        case 'PAUSE_SESSION':
        case 'RESUME_SESSION':
        case 'GET_CURRENT_CHANNEL':
        case 'UPDATE_SESSION_TITLE':
        case 'GET_ACTIVE_TAB_INFO':
        case 'MANUAL_TRACK_START':
          return handleTrackingMessage(message, messageSender, context);

        case 'GET_PENDING_ENTRIES':
        case 'DELETE_PENDING_ENTRY':
        case 'DELETE_PENDING_BY_SERVER_ID':
        case 'CLEAR_SYNCED_ENTRIES':
        case 'UPDATE_PENDING_ENTRY_TITLE':
          return handlePendingMessage(message, context);

        case 'JP343_SITE_LOADED':
        case 'GET_SETTINGS':
        case 'UPDATE_SETTINGS':
        case 'SET_ENABLED':
        case 'BLOCK_CHANNEL':
        case 'UNBLOCK_CHANNEL':
          return handleSettingsMessage(message, messageSender, context);

        case 'SYNC_ENTRIES_DIRECT':
        case 'OPEN_DASHBOARD':
        case 'GET_STATS':
        case 'RESET_STATS':
          return handleStatsSyncMessage(message, context);

        case 'DIAGNOSTIC_EVENT':
        case 'GET_DIAGNOSTICS':
          return handleDiagnosticsMessage(message, diagnosticsContext);

        default:
          return { success: false, error: 'Unknown message type' };
      }
    } catch (error) {
      context.log('[JP343] Error in handleMessage:', getMessageType(message), error);
      return { success: false, error: 'Internal error' };
    }
  };
}
