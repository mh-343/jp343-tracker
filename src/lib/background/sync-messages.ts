import { STORAGE_KEYS } from '../../types';
import type { ExtensionMessage, PendingEntry, JP343UserState } from '../../types';
import type { BackgroundMessageContext } from './message-context';
import { prepareSyncQueue, readSyncPending, readSyncQueue, retryPendingSync } from './sync-queue';
import { hasSyncIssue } from '../sync-policy';
import { importPendingBackup } from './backup-import';

export interface SyncStatus {
  entries: PendingEntry[];
  signedIn: boolean;
  relogin: boolean;
  nextDispatchAt: number;
}

export async function handleSyncMessage(message: ExtensionMessage, context: BackgroundMessageContext): Promise<unknown> {
  await context.recoveryReady;
  if (message.type === 'IMPORT_PENDING_BACKUP') {
    const added = await importPendingBackup(message.entries, message.stats, message.dayStartHour);
    await prepareSyncQueue();
    return { success: true, data: { added } };
  }
  if (message.type === 'RETRY_PENDING_SYNC') {
    if (message.entryIds !== undefined && (!Array.isArray(message.entryIds) || message.entryIds.some(id => typeof id !== 'string'))) {
      return { success: false, error: 'Invalid session selection' };
    }
    await retryPendingSync(message.entryIds);
    void context.syncEntriesDirect().catch(error => context.log('[JP343] Retry failed:', error));
    return { success: true };
  }
  await prepareSyncQueue();
  const [pending, queue, stored] = await Promise.all([
    readSyncPending(), readSyncQueue(), browser.storage.local.get([STORAGE_KEYS.USER, STORAGE_KEYS.RELOGIN_REQUIRED])
  ]);
  const user = stored[STORAGE_KEYS.USER] as JP343UserState | undefined;
  const relogin = !!stored[STORAGE_KEYS.RELOGIN_REQUIRED];
  const data: SyncStatus = {
    entries: pending.filter(e => hasSyncIssue(e) || (relogin && !e.synced)),
    signedIn: !!user?.isLoggedIn, relogin,
    nextDispatchAt: Math.max(queue.notBefore, queue.serverNotBefore)
  };
  return { success: true, data };
}
