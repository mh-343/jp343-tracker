import type { PendingEntry, ExtensionStats, JP343UserState, TrackingSession } from '../../types';
import { DEFAULT_STATS, STORAGE_KEYS } from '../../types';
import { getLocalDateString } from '../../lib/format-utils';
import { fetchServerStats, fetchServerSessions } from './api';
import { setupThemeToggle } from './theme';
import { setupAuthUI, tryRefreshNonce, isLoggingOut, renderSyncCta, renderTierBadge, renderAuthUI } from './auth';
import { setLocalDailyMinutes, setGoalMinutes, renderGoalBar, setupGoalEditor, renderStats, renderHeatmap, renderWeekBars, renderMonthBars, applyServerStats, applyCachedServerStats } from './stats';
import { showSessionsLoading, renderSessions, renderServerSessions } from './sessions';
import { renderFooter } from './footer';
import { loadNews } from './news';
import { setupSettings } from './settings';

interface DashboardData {
  entries: PendingEntry[];
  stats: ExtensionStats;
  userState: JP343UserState | null;
  activeSession: TrackingSession | null;
  goalMinutes: number;
}

async function loadData(): Promise<DashboardData> {
  const result = await browser.storage.local.get([
    STORAGE_KEYS.PENDING,
    STORAGE_KEYS.STATS,
    STORAGE_KEYS.USER,
    STORAGE_KEYS.SESSION,
    STORAGE_KEYS.SETTINGS
  ]);

  return {
    entries: result[STORAGE_KEYS.PENDING] || [],
    stats: result[STORAGE_KEYS.STATS] || DEFAULT_STATS,
    userState: result[STORAGE_KEYS.USER] || null,
    activeSession: result[STORAGE_KEYS.SESSION] || null,
    goalMinutes: result[STORAGE_KEYS.SETTINGS]?.dailyGoalMinutes ?? 60
  };
}

let isRefreshing = false;
let refreshPending = false;
let initialLoadDone = false;

async function refresh(): Promise<void> {
  if (isRefreshing) {
    refreshPending = true;
    return;
  }
  isRefreshing = true;

  try {
    const data = await loadData();
    setLocalDailyMinutes({ ...data.stats.dailyMinutes });
    setGoalMinutes(data.goalMinutes);
    renderGoalBar(data.stats.dailyMinutes[getLocalDateString()] || 0, data.goalMinutes);
    const isLoggedIn = data.userState?.isLoggedIn && (!!data.userState?.extApiToken || !!data.userState?.nonce);

    renderHeatmap(data.stats.dailyMinutes);
    renderWeekBars(data.stats.dailyMinutes);
    renderMonthBars(data.stats.dailyMinutes);
    renderSyncCta(data.entries, data.userState);
    renderTierBadge(data.userState);
    renderAuthUI(data.userState);
    renderFooter(data.userState);

    if (isLoggedIn) {
      await applyCachedServerStats();
      if (!initialLoadDone) showSessionsLoading();

      const activeState = data.userState!.extApiToken
        ? data.userState!
        : (await tryRefreshNonce(data.userState!)) || data.userState!;

      if (activeState.nonce || activeState.extApiToken) {
        const [serverStats, serverSessions] = await Promise.all([
          fetchServerStats(activeState),
          fetchServerSessions(activeState)
        ]);
        if (serverStats) {
          applyServerStats(serverStats);
        }
        if (serverSessions) {
          const freshPending: PendingEntry[] =
            (await browser.storage.local.get(STORAGE_KEYS.PENDING))[STORAGE_KEYS.PENDING] || [];
          const unsynced = freshPending.filter(e => !e.synced);
          renderServerSessions(serverSessions, unsynced);
        } else {
          renderSessions(data.entries);
        }
      } else {
        renderSessions(data.entries);
      }
      renderTierBadge(activeState);
      renderAuthUI(activeState);
      renderFooter(activeState);
    } else {
      renderStats(data.stats);
      renderSessions(data.entries);
    }
  } finally {
    initialLoadDone = true;
    isRefreshing = false;
    if (refreshPending) {
      refreshPending = false;
      refresh();
    }
  }
}

document.addEventListener('jp343:refresh', () => refresh());

function setupTabNav(): void {
  const tabs = [
    { btn: document.getElementById('tabBtnStats'), panel: document.getElementById('tabStats') },
    { btn: document.getElementById('tabBtnBlocked'), panel: document.getElementById('tabBlocked') },
    { btn: document.getElementById('tabBtnSettings'), panel: document.getElementById('tabSettings') }
  ];
  if (tabs.some(t => !t.btn || !t.panel)) return;

  for (const tab of tabs) {
    tab.btn!.addEventListener('click', () => {
      for (const t of tabs) {
        t.btn!.setAttribute('aria-selected', String(t === tab));
        t.panel!.style.display = t === tab ? '' : 'none';
      }
    });
  }

  const urlTab = new URLSearchParams(location.search).get('tab');
  if (urlTab === 'settings') tabs[2].btn!.click();
  if (urlTab === 'blocked') tabs[1].btn!.click();
}

setupThemeToggle();
setupAuthUI();
setupTabNav();
refresh().then(async () => {
  const result = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
  const goal: number = result[STORAGE_KEYS.SETTINGS]?.dailyGoalMinutes ?? 60;
  setupGoalEditor(goal);
  await setupSettings();
});
loadNews();

browser.storage.onChanged.addListener((changes, area) => {
  if (isLoggingOut) return;
  if (area === 'local' && (
    changes[STORAGE_KEYS.PENDING] ||
    changes[STORAGE_KEYS.STATS] ||
    changes[STORAGE_KEYS.USER]
  )) {
    refresh();
  }
});
