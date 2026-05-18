import type { PendingEntry, ExtensionStats, JP343UserState, TrackingSession } from '../../types';
import { DEFAULT_STATS, STORAGE_KEYS } from '../../types';
import { getLocalDateString } from '../../lib/format-utils';
import { fetchServerStats, fetchServerSessions } from './api';
import { setupThemeToggle } from './theme';
import { setupAuthUI, tryRefreshNonce, isLoggingOut, renderSyncCta, renderTierBadge, renderAuthUI } from './auth';
import { setLocalDailyMinutes, setLocalHourlyMinutes, setLocalFirstSessions, setGoalMinutes, setDayStartHour, renderGoalBar, setupGoalEditor, renderStats, renderHeatmap, renderWeekBars, renderMonthBars, renderHourlyBars, applyServerStats, applyCachedServerStats } from './stats';
import { setTargetStartTimes, setDayStartHourForTargetStart, computeLocalFirstSessions, renderTargetStartFromLocal, renderTargetStartChart } from './target-start';
import { showSessionsLoading, renderSessions, renderServerSessions, getCachedServerSessions, cacheServerSessions, clearRawCache } from './sessions';
import { renderFooter } from './footer';
import { loadNews } from './news';
import { setupSettings } from './settings';
import { applyDashboardBackground } from '../../lib/background-image';
import { applyColorTheme } from '../../lib/theme';
import { reportError, flushErrors } from '../../lib/error-reporter';

interface DashboardData {
  entries: PendingEntry[];
  stats: ExtensionStats;
  userState: JP343UserState | null;
  activeSession: TrackingSession | null;
  goalMinutes: number;
  dayStartHour: number;
  targetStartTimes: (string | null)[];
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
    goalMinutes: result[STORAGE_KEYS.SETTINGS]?.dailyGoalMinutes ?? 60,
    dayStartHour: Math.max(0, Math.min(6, result[STORAGE_KEYS.SETTINGS]?.dayStartHour ?? 0)),
    targetStartTimes: result[STORAGE_KEYS.SETTINGS]?.targetStartTimes ?? [null, null, null, null, null, null, null]
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
    setLocalHourlyMinutes({ ...(data.stats.hourlyMinutes || {}) });
    setGoalMinutes(data.goalMinutes);
    setDayStartHour(data.dayStartHour);
    renderGoalBar(data.stats.dailyMinutes[getLocalDateString(new Date(), data.dayStartHour)] || 0, data.goalMinutes);
    const isLoggedIn = data.userState?.isLoggedIn && (!!data.userState?.extApiToken || !!data.userState?.nonce);

    renderHeatmap(data.stats.dailyMinutes);
    renderWeekBars(data.stats.dailyMinutes);
    renderMonthBars(data.stats.dailyMinutes);
    renderHourlyBars(data.stats.hourlyMinutes ?? {});
    setTargetStartTimes(data.targetStartTimes);
    setDayStartHourForTargetStart(data.dayStartHour);
    const localFirst = computeLocalFirstSessions(data.entries, data.dayStartHour);
    setLocalFirstSessions(localFirst);
    renderSyncCta(data.entries, data.userState);
    renderTierBadge(data.userState);
    renderAuthUI(data.userState);
    renderFooter(data.userState);

    if (isLoggedIn) {
      await applyCachedServerStats();

      const activeState = data.userState!.extApiToken
        ? data.userState!
        : (await tryRefreshNonce(data.userState!)) || data.userState!;

      if (activeState.nonce || activeState.extApiToken) {
        const cached = getCachedServerSessions();
        if (cached) {
          const freshPending: PendingEntry[] =
            (await browser.storage.local.get(STORAGE_KEYS.PENDING))[STORAGE_KEYS.PENDING] || [];
          const unsynced = freshPending.filter(e => !e.synced);
          renderServerSessions(cached, unsynced);
          const serverStats = await fetchServerStats(activeState);
          if (serverStats) applyServerStats(serverStats);
        } else {
          if (!initialLoadDone) showSessionsLoading();
          const [serverStats, serverSessions] = await Promise.all([
            fetchServerStats(activeState),
            fetchServerSessions(activeState)
          ]);
          if (serverStats) applyServerStats(serverStats);
          if (serverSessions) {
            cacheServerSessions(serverSessions);
            const freshPending: PendingEntry[] =
              (await browser.storage.local.get(STORAGE_KEYS.PENDING))[STORAGE_KEYS.PENDING] || [];
            const unsynced = freshPending.filter(e => !e.synced);
            renderServerSessions(serverSessions, unsynced);
          } else {
            renderSessions(data.entries);
          }
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
      renderTargetStartFromLocal(data.entries);
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
    { btn: document.getElementById('tabBtnChannels'), panel: document.getElementById('tabChannels') },
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
  if (urlTab === 'blocked' || urlTab === 'channels') tabs[1].btn!.click();
}

function setupCardCollapse(): void {
  browser.storage.local.get(STORAGE_KEYS.COLLAPSED_CARDS).then(result => {
    const collapsed: string[] = result[STORAGE_KEYS.COLLAPSED_CARDS] || [];
    const cards = document.querySelectorAll<HTMLElement>('[data-collapse-id]');
    for (const card of cards) {
      const id = card.dataset.collapseId!;
      if (collapsed.includes(id)) card.classList.add('collapsed');
      const title = card.querySelector('.card-title');
      if (!title) continue;
      title.addEventListener('click', () => {
        card.classList.toggle('collapsed');
        const current = [...document.querySelectorAll<HTMLElement>('[data-collapse-id].collapsed')]
          .map(el => el.dataset.collapseId!);
        browser.storage.local.set({ [STORAGE_KEYS.COLLAPSED_CARDS]: current });
      });
    }
  });
}

window.addEventListener('error', (event) => {
  reportError(event.message || 'Unknown error', event.filename || 'dashboard.ts', event.error?.stack || '', 'dashboard');
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  reportError(reason?.message || String(reason), 'dashboard.ts', reason?.stack || '', 'dashboard');
});
window.addEventListener('beforeunload', () => { flushErrors(); });

setupThemeToggle();
setupAuthUI();
setupTabNav();
setupCardCollapse();

browser.storage.local.get(STORAGE_KEYS.SETTINGS).then(result => {
  const settings = result[STORAGE_KEYS.SETTINGS];
  applyDashboardBackground(settings?.backgroundEnabled ?? false, settings?.backgroundOpacity ?? 75);
  setupGoalEditor(settings?.dailyGoalMinutes ?? 60);
  applyColorTheme(settings?.colorTheme ?? 'magenta');
});
setupSettings();
refresh();
loadNews();

browser.storage.onChanged.addListener((changes, area) => {
  if (isLoggingOut) return;
  if (area === 'local' && (
    changes[STORAGE_KEYS.PENDING] ||
    changes[STORAGE_KEYS.STATS] ||
    changes[STORAGE_KEYS.USER] ||
    changes[STORAGE_KEYS.SETTINGS]
  )) {
    if (changes[STORAGE_KEYS.PENDING]) clearRawCache();
    refresh();
  }
  if (area === 'local' && changes[STORAGE_KEYS.SETTINGS]) {
    const oldSettings = changes[STORAGE_KEYS.SETTINGS].oldValue;
    const newSettings = changes[STORAGE_KEYS.SETTINGS].newValue;
    if (oldSettings?.colorTheme !== newSettings?.colorTheme) {
      applyColorTheme(newSettings?.colorTheme ?? 'magenta');
    }
    if (oldSettings?.backgroundEnabled !== newSettings?.backgroundEnabled ||
        oldSettings?.backgroundOpacity !== newSettings?.backgroundOpacity) {
      applyDashboardBackground(
        newSettings?.backgroundEnabled ?? false,
        newSettings?.backgroundOpacity ?? 75
      );
    }
  }
  if (area === 'local' && changes[STORAGE_KEYS.AVATAR_DATA]) {
    const avatarEl = document.getElementById('userAvatar') as HTMLImageElement | null;
    if (avatarEl) {
      const newData = changes[STORAGE_KEYS.AVATAR_DATA].newValue;
      if (newData) {
        browser.storage.local.get([STORAGE_KEYS.USER, STORAGE_KEYS.AVATAR_USER_ID]).then(result => {
          const currentUserId = result[STORAGE_KEYS.USER]?.userId;
          const cachedUserId = result[STORAGE_KEYS.AVATAR_USER_ID] as number | undefined;
          if (cachedUserId == null || cachedUserId === currentUserId) {
            avatarEl.src = newData;
            avatarEl.style.display = '';
          }
        });
      } else {
        avatarEl.src = '/avatar-default.png';
        avatarEl.style.display = '';
      }
    }
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});
