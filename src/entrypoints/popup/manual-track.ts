import type { TrackingSession, ActiveTabInfo, ActivityType } from '../../types';
import { STORAGE_KEYS } from '../../types';
import type { createPlayerCard } from './player-card';

const DEBUG_MODE = import.meta.env.DEV;
const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};

type PlayerCard = ReturnType<typeof createPlayerCard>;

export interface ManualTrackElements {
  noSession: HTMLElement;
  manualTrackMode: HTMLElement;
  currentDomain: HTMLElement;
  manualTitle: HTMLInputElement;
  activityTypeSelect: HTMLSelectElement;
  btnStartManual: HTMLButtonElement;
}

export interface ManualTrackOptions {
  elements: ManualTrackElements;
  playerCard: Pick<PlayerCard, 'visible' | 'placeholderHint'>;
  getCurrentSession: () => TrackingSession | null;
  loadAndApplySettings: () => Promise<void>;
  fetchCurrentState: () => Promise<void>;
  showToast: (message: string, type?: 'warning' | 'success') => void;
}

export function createManualTrack(options: ManualTrackOptions): {
  loadActiveTabInfo: () => Promise<void>;
  updateDisplay: () => void;
  activeTabInfo: () => ActiveTabInfo | null;
} {
  const { elements, playerCard, getCurrentSession, loadAndApplySettings, fetchCurrentState, showToast } = options;
  let activeTabInfo: ActiveTabInfo | null = null;
  let lastLoadedDomain = '';

  async function loadActiveTabInfo(): Promise<void> {
    try {
      const response = await browser.runtime.sendMessage({ type: 'GET_ACTIVE_TAB_INFO' });
      if (response.success && response.data) {
        activeTabInfo = response.data as ActiveTabInfo;
        updateManualTrackDisplay();
        loadAndApplySettings();
        if (activeTabInfo.domain?.includes('youtube.com')) {
          const jpBtn = document.getElementById('btnJpFilter');
          if (jpBtn) (jpBtn as HTMLElement).style.display = 'flex';
        }
        if (activeTabInfo.tabId) {
          browser.tabs.sendMessage(activeTabInfo.tabId, { type: 'TAB_ACTIVATED' }).catch(() => {});
        }
      }
    } catch (error) {
      log('[JP343 Popup] Failed to load tab info:', error);
    }
  }

  function updateManualTrackDisplay(): void {
    if (!activeTabInfo) {
      elements.manualTrackMode.style.display = 'none';
      return;
    }

    const shouldShowManual = !getCurrentSession() && !activeTabInfo.isStreamingSite;

    if (shouldShowManual) {
      elements.noSession.style.display = 'none';
      elements.manualTrackMode.style.display = 'block';
      elements.currentDomain.textContent = activeTabInfo.domain;
      elements.manualTitle.value = activeTabInfo.title;
      elements.manualTitle.placeholder = activeTabInfo.title;
      if (lastLoadedDomain !== activeTabInfo.domain) {
        lastLoadedDomain = activeTabInfo.domain;
        loadActivityTypePreference(activeTabInfo.domain);
      }
    } else {
      elements.manualTrackMode.style.display = 'none';
      if (!getCurrentSession()) {
        elements.noSession.style.display = playerCard.visible() ? 'none' : 'block';
        const noSessionTitle = document.getElementById('noSessionTitle');
        const noSessionHint = document.getElementById('noSessionHint');
        if (activeTabInfo.isStreamingSite && noSessionTitle && noSessionHint) {
          noSessionTitle.textContent = 'Waiting for playback';
          noSessionHint.textContent = 'Start a video to auto-track';
        } else if (noSessionTitle && noSessionHint) {
          noSessionTitle.textContent = 'No active session';
          noSessionHint.textContent = playerCard.placeholderHint() ?? 'Visit a supported streaming site to start tracking';
        }
      }
    }
  }

  async function loadActivityTypePreference(domain: string): Promise<void> {
    try {
      const result = await browser.storage.local.get(STORAGE_KEYS.ACTIVITY_PREFS);
      const prefs = result[STORAGE_KEYS.ACTIVITY_PREFS] as Record<string, ActivityType> | undefined;
      elements.activityTypeSelect.value = prefs?.[domain] ?? 'watching';
    } catch {
      elements.activityTypeSelect.value = 'watching';
    }
  }

  async function saveActivityTypePreference(domain: string, activityType: ActivityType): Promise<void> {
    try {
      const result = await browser.storage.local.get(STORAGE_KEYS.ACTIVITY_PREFS);
      const prefs = (result[STORAGE_KEYS.ACTIVITY_PREFS] as Record<string, ActivityType>) ?? {};
      prefs[domain] = activityType;
      await browser.storage.local.set({ [STORAGE_KEYS.ACTIVITY_PREFS]: prefs });
    } catch { /* non-critical */ }
  }

  elements.btnStartManual.addEventListener('click', async () => {
    if (!activeTabInfo) return;

    const title = elements.manualTitle.value.trim() || activeTabInfo.title;
    const activityType = elements.activityTypeSelect.value as ActivityType;

    await saveActivityTypePreference(activeTabInfo.domain, activityType);

    try {
      const response = await browser.runtime.sendMessage({
        type: 'MANUAL_TRACK_START',
        title: title,
        url: activeTabInfo.url,
        tabId: activeTabInfo.tabId,
        activityType
      });

      if (response.success) {
        await fetchCurrentState();
      } else {
        log('[JP343 Popup] Failed to start:', response.error);
        showToast(response.error || 'Could not start tracking', 'warning');
      }
    } catch (error) {
      log('[JP343 Popup] Error:', error);
      showToast('Could not start tracking', 'warning');
    }
  });

  return { loadActiveTabInfo, updateDisplay: updateManualTrackDisplay, activeTabInfo: () => activeTabInfo };
}
