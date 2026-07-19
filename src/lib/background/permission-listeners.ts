import type { PendingEntry, SavePendingResult, TrackingSession } from '../../types';
import { tracker } from '../time-tracker';
import { scheduleStatusBadgeUpdate } from '../badge-service';
import { readerSourceForOrigins } from '../reader-sources';
import { syncReaderRegistration } from './reader-sync';
import { syncCustomSitesRegistration, originsIncludeHost } from './custom-sites';
import { reinjectReaderTabs, reinjectCustomSitesTabs } from './reinject';

interface PermissionListenerDeps {
  log: (...args: unknown[]) => void;
  savePendingEntry: (entry: PendingEntry) => Promise<SavePendingResult>;
  saveSessionState: (session: TrackingSession | null) => Promise<void>;
}

export async function finalizeRevokedCustomSession(
  origins: string[],
  deps: Pick<PermissionListenerDeps, 'savePendingEntry' | 'saveSessionState'>
): Promise<void> {
  const session = tracker.getCurrentSession();
  if (!session || session.platform !== 'generic') return;
  let host: string;
  try { host = new URL(session.url).hostname; } catch { return; }
  if (!originsIncludeHost(origins, host)) return;
  const entry = tracker.finalizeSession();
  if (entry) await deps.savePendingEntry(entry);
  await deps.saveSessionState(null);
  scheduleStatusBadgeUpdate();
}

export function initPermissionListeners(deps: PermissionListenerDeps): void {
  if (browser.permissions?.onAdded) {
    // Re-grant of a reader host access
    browser.permissions.onAdded.addListener((perms) => {
      const source = readerSourceForOrigins(perms.origins);
      if (!source) return;
      void syncReaderRegistration(source).then(() => reinjectReaderTabs(deps.log));
    });
    browser.permissions.onAdded.addListener((perms) => {
      if (!perms.origins?.length) return;
      void syncCustomSitesRegistration().then(() => reinjectCustomSitesTabs(deps.log));
    });
  }
  if (browser.permissions?.onRemoved) {
    browser.permissions.onRemoved.addListener((perms) => {
      if (!perms.origins?.length) return;
      void syncCustomSitesRegistration();
      void finalizeRevokedCustomSession(perms.origins, deps);
    });
  }
}
