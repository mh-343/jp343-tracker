import type { ExtensionMessage } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { updateBadge } from '../badge-service';
import { loadPendingEntries } from '../pending-entries';
import { withStorageLock } from '../storage-lock';
import type { BackgroundMessageContext } from './message-context';

export async function handlePendingMessage(
  message: ExtensionMessage,
  context: BackgroundMessageContext
): Promise<unknown> {
  switch (message.type) {
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
          const deletedEntry = pending.find(e => e.id === message.entryId);
          const filtered = pending.filter(e => e.id !== message.entryId);
          await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: filtered });
          updateBadge();
          if (deletedEntry) {
            await context.subtractFromStats(deletedEntry);
          }
          return { success: true, data: { remaining: filtered.length } };
        });
      }
      return { success: false, error: 'No entryId provided' };
    }

    case 'DELETE_PENDING_BY_SERVER_ID': {
      if ('serverEntryId' in message && typeof message.serverEntryId === 'number') {
        return withStorageLock(async () => {
          const pending = await loadPendingEntries();
          const match = pending.find(e => e.serverEntryId === message.serverEntryId);
          if (!match) return { success: true, data: { found: false } };
          const filtered = pending.filter(e => e.serverEntryId !== message.serverEntryId);
          await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: filtered });
          updateBadge();
          await context.subtractFromStats(match);
          return { success: true, data: { found: true } };
        });
      }
      return { success: false, error: 'No serverEntryId provided' };
    }

    case 'CLEAR_SYNCED_ENTRIES': {
      return withStorageLock(async () => {
        const pending = await loadPendingEntries();
        const unsynced = pending.filter(e => !e.synced);
        await browser.storage.local.set({ [STORAGE_KEYS.PENDING]: unsynced });
        updateBadge();
        return { success: true, data: { removed: pending.length - unsynced.length } };
      });
    }

    case 'UPDATE_PENDING_ENTRY_TITLE': {
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
          context.log('[JP343] Pending entry title updated:', message.title);
          return { success: true };
        });
      }
      return { success: false, error: 'No entryId or title provided' };
    }

    default:
      return { success: false, error: 'Unknown message type' };
  }
}
