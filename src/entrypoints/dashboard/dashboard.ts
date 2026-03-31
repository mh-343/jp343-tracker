import type { PendingEntry, ExtensionStats, JP343UserState, TrackingSession } from '../../types';
import { DEFAULT_STATS, STORAGE_KEYS } from '../../types';
import { fetchServerStats, fetchServerSessions } from './api';
import { setupThemeToggle } from './theme';
import { setupAuthUI, tryRefreshNonce, isLoggingOut, renderSyncCta, renderTierBadge, renderAuthUI } from './auth';
import { setLocalDailyMinutes, renderStats, renderHeatmap, renderWeekBars, renderMonthBars, applyServerStats, applyCachedServerStats } from './stats';
import { showSessionsLoading, renderSessions, renderServerSessions } from './sessions';
import { renderFooter } from './footer';
import { loadNews } from './news';

interface DashboardData {
  entries: PendingEntry[];
  stats: ExtensionStats;
  userState: JP343UserState | null;
  activeSession: TrackingSession | null;
}

async function loadData(): Promise<DashboardData> {
  const result = await browser.storage.local.get([
    STORAGE_KEYS.PENDING,
    STORAGE_KEYS.STATS,
    STORAGE_KEYS.USER,
    STORAGE_KEYS.SESSION
  ]);

  return {
    entries: result[STORAGE_KEYS.PENDING] || [],
    stats: result[STORAGE_KEYS.STATS] || DEFAULT_STATS,
    userState: result[STORAGE_KEYS.USER] || null,
    activeSession: result[STORAGE_KEYS.SESSION] || null
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
    const isLoggedIn = data.userState?.isLoggedIn && (!!data.userState?.extApiToken || !!data.userState?.nonce);

    renderHeatmap(data.stats.dailyMinutes);
    renderWeekBars(data.stats.dailyMinutes);
    renderMonthBars(data.stats.dailyMinutes);
    renderSyncCta(data.entries, data.userState);
    renderTierBadge(data.userState);
    renderAuthUI(data.userState);
    renderFooter();

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

setupThemeToggle();
setupAuthUI();
refresh();
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
