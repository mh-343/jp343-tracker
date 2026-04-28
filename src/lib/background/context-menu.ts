import type { PendingEntry, TrackingSession } from '../../types';
import { tracker } from '../time-tracker';
import { scheduleStatusBadgeUpdate } from '../badge-service';

interface ContextMenuDeps {
  recoveryReady: Promise<void>;
  saveSessionState: (session: TrackingSession | null) => Promise<void>;
  savePendingEntry: (entry: PendingEntry) => Promise<void>;
}

export function initContextMenu(deps: ContextMenuDeps): () => void {
  if (!browser.contextMenus) {
    return () => {};
  }

  browser.contextMenus.create({
    id: 'jp343-toggle-pause',
    title: 'Pause Tracking',
    contexts: ['all'],
    visible: false
  });
  browser.contextMenus.create({
    id: 'jp343-stop',
    title: 'Stop & Save',
    contexts: ['all'],
    visible: false
  });

  function updateTrackingMenu(): void {
    const session = tracker.getCurrentSession();
    if (!session) {
      browser.contextMenus.update('jp343-toggle-pause', { visible: false }).catch(() => {});
      browser.contextMenus.update('jp343-stop', { visible: false }).catch(() => {});
    } else {
      browser.contextMenus.update('jp343-toggle-pause', {
        visible: true,
        title: session.isPaused ? '\u25B6 Resume Tracking' : '\u23F8 Pause Tracking'
      }).catch(() => {});
      browser.contextMenus.update('jp343-stop', { visible: true }).catch(() => {});
    }
  }

  browser.contextMenus.onClicked.addListener(async (info) => {
    await deps.recoveryReady;
    const session = tracker.getCurrentSession();
    if (!session) return;

    if (info.menuItemId === 'jp343-toggle-pause') {
      if (session.isPaused) {
        tracker.resumeSession();
        if (session.tabId) {
          try { await browser.tabs.sendMessage(session.tabId, { type: 'RESUME_VIDEO' }); } catch { /* ignore */ }
        }
      } else {
        if (session.tabId) {
          try { await browser.tabs.sendMessage(session.tabId, { type: 'PAUSE_VIDEO' }); } catch { /* ignore */ }
        }
        tracker.pauseSession();
      }
      await deps.saveSessionState(tracker.getCurrentSession());
      scheduleStatusBadgeUpdate();
    }

    if (info.menuItemId === 'jp343-stop') {
      if (session.tabId) {
        try { await browser.tabs.sendMessage(session.tabId, { type: 'PAUSE_VIDEO' }); } catch { /* ignore */ }
      }
      const entry = tracker.stopSession();
      if (entry) await deps.savePendingEntry(entry);
      await deps.saveSessionState(null);
      scheduleStatusBadgeUpdate();
    }

    updateTrackingMenu();
  });

  return updateTrackingMenu;
}
