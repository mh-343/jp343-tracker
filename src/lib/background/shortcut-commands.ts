import type { ExtensionMessage, ActivityType, ActiveTabInfo } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { tracker } from '../time-tracker';

type Dispatch = (message: ExtensionMessage, sender: Browser.runtime.MessageSender) => Promise<unknown>;

const noSender: Browser.runtime.MessageSender = {};

async function startTrackingActiveTab(dispatch: Dispatch): Promise<void> {
  if (tracker.getCurrentSession()) return;

  const info = await dispatch({ type: 'GET_ACTIVE_TAB_INFO' }, noSender) as {
    success: boolean;
    data?: ActiveTabInfo;
  };
  if (!info.success || !info.data || info.data.isStreamingSite) return;

  const stored = await browser.storage.local.get(STORAGE_KEYS.ACTIVITY_PREFS);
  const prefs = stored[STORAGE_KEYS.ACTIVITY_PREFS] as Record<string, ActivityType> | undefined;
  const activityType: ActivityType = prefs?.[info.data.domain] ?? 'watching';

  await dispatch({
    type: 'MANUAL_TRACK_START',
    title: info.data.title,
    url: info.data.url,
    tabId: info.data.tabId,
    activityType
  }, noSender);
}

export function handleShortcutCommand(command: string, dispatch: Dispatch): void {
  if (command === 'toggle-tracking') {
    if (tracker.getCurrentSession()) {
      dispatch({ type: 'STOP_SESSION' }, noSender).catch(() => {});
    } else {
      startTrackingActiveTab(dispatch).catch(() => {});
    }
    return;
  }
  if (command !== 'toggle-pause') return;

  const session = tracker.getCurrentSession();
  if (!session) return;
  if (session.isPaused) {
    dispatch({ type: 'RESUME_SESSION' }, noSender).catch(() => {});
  } else {
    dispatch({ type: 'PAUSE_SESSION' }, noSender).catch(() => {});
  }
}
