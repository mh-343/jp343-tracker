
import type { PendingEntry, ExtensionStats, JP343UserState, TrackingSession } from '../../types';
import { DEFAULT_STATS } from '../../types';
import { formatStatDuration, formatDuration, isValidImageUrl, formatSessionDate, getLocalDateString, getWeekDates } from '../../lib/format-utils';

const STORAGE_KEYS = {
  PENDING: 'jp343_extension_pending',
  STATS: 'jp343_extension_stats',
  USER: 'jp343_extension_user',
  SESSION: 'jp343_extension_session'
};

const AJAX_URL = 'https://jp343.com/wp-admin/admin-ajax.php';

let sessionDisplayCount = 20;

const platformIcons: Record<string, string> = {
  youtube: '▶',
  netflix: 'N',
  crunchyroll: 'C',
  generic: '⏵'
};

// Daten laden

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

// Auth: Login, Nonce Refresh, Logout

async function ajaxPost(action: string, params: Record<string, string> = {}): Promise<any> {
  const body = new URLSearchParams({ action, ...params });
  const response = await fetch(AJAX_URL, {
    method: 'POST',
    credentials: 'include',
    body
  });
  return response.json();
}

async function tryRefreshNonce(userState: JP343UserState): Promise<JP343UserState | null> {
  try {
    const result = await ajaxPost('jp343_extension_nonce_refresh');
    if (result.success && result.data?.nonce) {
      const updated: JP343UserState = {
        ...userState,
        nonce: result.data.nonce,
        isLoggedIn: true,
        userId: result.data.userId,
      };
      await browser.storage.local.set({ [STORAGE_KEYS.USER]: updated });
      return updated;
    }
  } catch {}
  return null;
}

async function doLogin(email: string, password: string): Promise<{ success: boolean; error?: string; userState?: JP343UserState }> {
  try {
    const response = await fetch(AJAX_URL, {
      method: 'POST',
      credentials: 'include',
      body: new URLSearchParams({
        action: 'jp343_extension_auth',
        email,
        password
      })
    });

    const text = await response.text();

    let result: any;
    try {
      result = JSON.parse(text);
    } catch {
      return { success: false, error: `Server returned non-JSON (${response.status})` };
    }

    if (result.success && result.data?.nonce) {
      const userState: JP343UserState = {
        isLoggedIn: true,
        userId: result.data.userId,
        nonce: result.data.nonce,
        ajaxUrl: result.data.ajaxUrl || AJAX_URL,
        guestToken: null
      };
      await browser.storage.local.set({
        [STORAGE_KEYS.USER]: userState,
        jp343_extension_display_name: result.data.displayName || null
      });

      try {
        await browser.runtime.sendMessage({ type: 'SYNC_ENTRIES_DIRECT' });
      } catch { /* Sync-Fehler nicht Login-blockierend */ }

      return { success: true, userState };
    }

    // Server-Fehlermeldung extrahieren
    const msg = result.data?.message || (typeof result.data === 'string' ? result.data : null) || 'Login failed';
    return { success: false, error: msg };
  } catch (e) {
    return { success: false, error: 'Network error — check your connection' };
  }
}

let isLoggingOut = false;
let isRefreshing = false;

async function doLogout(): Promise<void> {
  isLoggingOut = true;
  await browser.storage.local.remove([STORAGE_KEYS.USER, 'jp343_extension_display_name']);
  refresh();
  setTimeout(() => { isLoggingOut = false; }, 2000);
}

async function fetchServerStats(userState: JP343UserState): Promise<Record<string, any> | null> {
  if (!userState.nonce) return null;
  try {
    const result = await ajaxPost('jp343_get_time_stats', { nonce: userState.nonce });
    if (result.success) return result.data;
  } catch {}
  return null;
}

async function fetchServerSessions(userState: JP343UserState, limit = 20): Promise<any[] | null> {
  if (!userState.nonce) return null;
  try {
    const result = await ajaxPost('jp343_get_recent_sessions', {
      nonce: userState.nonce,
      limit: String(limit)
    });
    if (result.success && result.data?.sessions) return result.data.sessions;
  } catch {}
  return null;
}

function renderHeroTime(totalMinutes: number): void {
  const el = document.getElementById('heroTime');
  if (!el) return;
  el.classList.remove('skeleton');
  const totalSec = Math.round(totalMinutes * 60);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  el.textContent = '';

  const hNum = document.createElement('span');
  hNum.className = 'num';
  hNum.textContent = String(h);
  el.appendChild(hNum);

  const hUnit = document.createElement('span');
  hUnit.className = 'unit';
  hUnit.textContent = 'hr';
  el.appendChild(hUnit);

  const mNum = document.createElement('span');
  mNum.className = 'num';
  mNum.textContent = ` ${m}`;
  el.appendChild(mNum);

  const mUnit = document.createElement('span');
  mUnit.className = 'unit';
  mUnit.textContent = 'min';
  el.appendChild(mUnit);
}

async function doRegister(email: string, password: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(AJAX_URL, {
      method: 'POST',
      credentials: 'include',
      body: new URLSearchParams({
        action: 'jp343_extension_register',
        email,
        password
      })
    });

    const text = await response.text();

    let result: any;
    try { result = JSON.parse(text); } catch {
      return { success: false, error: `Server returned non-JSON (${response.status})` };
    }

    if (result.success && result.data?.nonce) {
      const userState: JP343UserState = {
        isLoggedIn: true,
        userId: result.data.userId,
        nonce: result.data.nonce,
        ajaxUrl: result.data.ajaxUrl || AJAX_URL,
        guestToken: null
      };
      await browser.storage.local.set({
        [STORAGE_KEYS.USER]: userState,
        jp343_extension_display_name: result.data.displayName || null
      });

      try {
        await browser.runtime.sendMessage({ type: 'SYNC_ENTRIES_DIRECT' });
      } catch {}

      return { success: true };
    }

    return { success: false, error: result.data?.message || 'Registration failed' };
  } catch (e) {
    return { success: false, error: 'Network error — check your connection' };
  }
}

function setupAuthUI(): void {
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  const logoutBtn = document.getElementById('btnLogout');
  const toggleLoginBtn = document.getElementById('btnToggleLogin');
  const toggleSignUpBtn = document.getElementById('btnSignUp');
  const loginDrawer = document.getElementById('loginDrawer');
  const registerDrawer = document.getElementById('registerDrawer');

  // Toggle Login-Drawer
  toggleLoginBtn?.addEventListener('click', () => {
    registerDrawer?.classList.remove('open');
    loginDrawer?.classList.toggle('open');
    if (loginDrawer?.classList.contains('open')) {
      (document.getElementById('loginEmail') as HTMLInputElement)?.focus();
    }
  });

  toggleSignUpBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    loginDrawer?.classList.remove('open');
    registerDrawer?.classList.toggle('open');
    if (registerDrawer?.classList.contains('open')) {
      (document.getElementById('regEmail') as HTMLInputElement)?.focus();
    }
  });

  // Login Submit
  loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailInput = document.getElementById('loginEmail') as HTMLInputElement;
    const passInput = document.getElementById('loginPassword') as HTMLInputElement;
    const btn = document.getElementById('btnLogin') as HTMLButtonElement;
    const errorEl = document.getElementById('loginError');

    btn.disabled = true;
    btn.textContent = 'Logging in...';
    if (errorEl) errorEl.textContent = '';

    const { success, error } = await doLogin(emailInput.value, passInput.value);

    if (success) {
      refresh();
    } else {
      if (errorEl) errorEl.textContent = error || 'Login failed';
      btn.disabled = false;
      btn.textContent = 'Login';
    }
  });

  // Register Submit
  registerForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const emailInput = document.getElementById('regEmail') as HTMLInputElement;
    const passInput = document.getElementById('regPassword') as HTMLInputElement;
    const gdprInput = document.getElementById('regGdpr') as HTMLInputElement;
    const btn = document.getElementById('btnRegister') as HTMLButtonElement;
    const errorEl = document.getElementById('registerError');

    if (!gdprInput.checked) {
      if (errorEl) errorEl.textContent = 'Please accept the Privacy Policy';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Creating account...';
    if (errorEl) errorEl.textContent = '';

    const { success, error } = await doRegister(emailInput.value, passInput.value);

    if (success) {
      refresh();
    } else {
      if (errorEl) errorEl.textContent = error || 'Registration failed';
      btn.disabled = false;
      btn.textContent = 'Create Account';
    }
  });

  logoutBtn?.addEventListener('click', doLogout);
}

// Hero Stats

function renderStats(stats: ExtensionStats): void {
  const todayStr = getLocalDateString();
  const todayMin = stats.dailyMinutes[todayStr] || 0;

  const weekDates = getWeekDates();
  const weekMin = weekDates.reduce((sum, d) => sum + (stats.dailyMinutes[d.date] || 0), 0);

  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthMin = Object.entries(stats.dailyMinutes)
    .filter(([date]) => date.startsWith(monthPrefix))
    .reduce((sum, [, min]) => sum + min, 0);

  setText('statToday', formatStatDuration(todayMin));
  setText('statWeek', formatStatDuration(weekMin));
  setText('statMonth', formatStatDuration(monthMin));
  setText('statStreak', `${stats.currentStreak}d`);
  renderHeroTime(stats.totalMinutes);
}

// Activity Heatmap (90 Tage)

function renderHeatmap(dailyMinutes: Record<string, number>): void {
  const container = document.getElementById('heatmap');
  if (!container) return;
  container.textContent = '';

  const today = new Date();
  // 91 Tage (13 Wochen): Grid rows=7 (Mo-So), auto-flow column
  const todayDayOfWeek = (today.getDay() + 6) % 7; // 0=Mo
  const startOffset = 90 + todayDayOfWeek;

  for (let i = startOffset; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);

    if (d > today) {
      const filler = document.createElement('div');
      filler.className = 'heatmap-cell';
      filler.style.visibility = 'hidden';
      container.appendChild(filler);
      continue;
    }

    const dateStr = getLocalDateString(d);
    const minutes = dailyMinutes[dateStr] || 0;

    const cell = document.createElement('div');
    cell.className = 'heatmap-cell';
    const level = minutes === 0 ? 0 : minutes < 30 ? 1 : minutes < 60 ? 2 : minutes < 120 ? 3 : 4;
    cell.dataset.level = String(level);
    cell.title = `${dateStr}: ${formatStatDuration(minutes)}`;
    container.appendChild(cell);
  }
}

// Week Bars

function renderWeekBars(dailyMinutes: Record<string, number>): void {
  const container = document.getElementById('weekBars');
  if (!container) return;
  container.textContent = '';

  const days = getWeekDates();
  const maxMin = Math.max(1, ...days.map(d => dailyMinutes[d.date] || 0));

  for (const day of days) {
    const min = dailyMinutes[day.date] || 0;
    const heightPct = Math.max(2, (min / maxMin) * 100);

    const col = document.createElement('div');
    col.className = 'week-bar-col';

    const value = document.createElement('div');
    value.className = 'week-bar-value';
    value.textContent = min > 0 ? formatStatDuration(min) : '';

    const bar = document.createElement('div');
    bar.className = `week-bar${day.isToday ? ' today' : ''}`;
    bar.style.height = `${heightPct}%`;

    const label = document.createElement('div');
    label.className = 'week-bar-label';
    label.textContent = day.label;

    col.appendChild(value);
    col.appendChild(bar);
    col.appendChild(label);
    container.appendChild(col);
  }
}

// Session History

function renderSessions(entries: PendingEntry[]): void {
  const container = document.getElementById('sessionList');
  if (!container) return;

  const sorted = [...entries].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const display = sorted.slice(0, sessionDisplayCount);

  if (display.length === 0) {
    container.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const icon = document.createElement('div');
    icon.className = 'empty-state-icon';
    icon.textContent = '🎧';
    const text = document.createElement('div');
    text.className = 'empty-state-text';
    text.textContent = 'No sessions yet. Start watching to see your history here.';
    empty.appendChild(icon);
    empty.appendChild(text);
    container.appendChild(empty);
    return;
  }

  container.textContent = '';

  for (const entry of display) {
    const item = document.createElement('div');
    item.className = 'session-item';

    // Thumbnail
    if (entry.thumbnail && isValidImageUrl(entry.thumbnail)) {
      const img = document.createElement('img');
      img.className = 'session-thumb';
      img.src = entry.thumbnail;
      img.alt = '';
      img.loading = 'lazy';
      item.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'session-thumb-placeholder';
      ph.textContent = platformIcons[entry.platform] || '⏵';
      item.appendChild(ph);
    }

    // Info
    const info = document.createElement('div');
    info.className = 'session-info';

    const title = document.createElement('div');
    title.className = 'session-title';
    title.textContent = entry.project;
    info.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'session-meta';

    const platform = document.createElement('span');
    platform.className = 'session-platform';
    platform.textContent = entry.platform;
    meta.appendChild(platform);

    const dateEl = document.createElement('span');
    dateEl.textContent = formatSessionDate(entry.date);
    meta.appendChild(dateEl);

    info.appendChild(meta);
    item.appendChild(info);

    // Dauer
    const dur = document.createElement('div');
    dur.className = 'session-duration';
    dur.textContent = formatDuration(entry.duration_min);
    item.appendChild(dur);

    // Delete Button
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-delete-entry';
    delBtn.textContent = '×';
    delBtn.title = 'Delete';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (entry.synced && entry.serverEntryId) {
        // Server-seitig loeschen
        const data = await loadData();
        if (data.userState?.nonce) {
          try {
            await ajaxPost('jp343_delete_time_entry', {
              nonce: data.userState.nonce,
              entry_id: String(entry.serverEntryId)
            });
          } catch { /* Server-Delete fehlgeschlagen — trotzdem lokal aufraumen */ }
        }
      }
      // Lokal loeschen
      await browser.runtime.sendMessage({ type: 'DELETE_PENDING_ENTRY', entryId: entry.id });
      refresh();
    });
    item.appendChild(delBtn);

    container.appendChild(item);
  }

  if (sorted.length > sessionDisplayCount) {
    const loadMore = document.createElement('button');
    loadMore.className = 'btn-sync-dashboard';
    loadMore.style.width = '100%';
    loadMore.style.marginTop = '12px';
    loadMore.textContent = `Load More (${sorted.length - sessionDisplayCount} remaining)`;
    loadMore.addEventListener('click', () => {
      sessionDisplayCount += 20;
      refresh();
    });
    container.appendChild(loadMore);
  }
}

let serverSessionsCache: any[] | null = null;
const INITIAL_SERVER_SESSIONS = 5;

function renderServerSessions(sessions: any[]): void {
  const container = document.getElementById('sessionList');
  if (!container) return;
  container.textContent = '';
  serverSessionsCache = sessions;

  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const icon = document.createElement('div');
    icon.className = 'empty-state-icon';
    icon.textContent = '🎧';
    const text = document.createElement('div');
    text.className = 'empty-state-text';
    text.textContent = 'No sessions yet. Start watching to see your history here.';
    empty.appendChild(icon);
    empty.appendChild(text);
    container.appendChild(empty);
    return;
  }

  const display = sessions.slice(0, INITIAL_SERVER_SESSIONS);
  const remaining = sessions.length - INITIAL_SERVER_SESSIONS;

  for (const session of display) {
    container.appendChild(createServerSessionItem(session));
  }

  if (remaining > 0) {
    const showMore = document.createElement('button');
    showMore.className = 'btn-sync-dashboard';
    showMore.style.width = '100%';
    showMore.style.marginTop = '12px';
    showMore.textContent = `Show ${remaining} more`;
    showMore.addEventListener('click', () => {
      showMore.remove();
      for (const session of sessions.slice(INITIAL_SERVER_SESSIONS)) {
        container.appendChild(createServerSessionItem(session));
      }
    });
    container.appendChild(showMore);
  }
}

function createServerSessionItem(session: any): HTMLElement {
  const item = document.createElement('div');
  item.className = 'session-item';

  // Thumbnail/Icon
  if (session.image && isValidImageUrl(session.image)) {
    const img = document.createElement('img');
    img.className = 'session-thumb';
    img.src = session.image;
    img.alt = '';
    img.loading = 'lazy';
    item.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'session-thumb-placeholder';
    ph.textContent = session.icon || '⏵';
    item.appendChild(ph);
  }

  // Info
  const info = document.createElement('div');
  info.className = 'session-info';

  const title = document.createElement('div');
  title.className = 'session-title';
  title.textContent = session.title || session.project_name || 'Session';
  info.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'session-meta';

  if (session.platform && session.platform !== 'manual') {
    const platform = document.createElement('span');
    platform.className = 'session-platform';
    platform.textContent = session.platform === 'extension' ? 'youtube' : session.platform;
    meta.appendChild(platform);
  }

  const dateEl = document.createElement('span');
  dateEl.textContent = formatSessionDate(session.date);
  meta.appendChild(dateEl);
  info.appendChild(meta);

  item.appendChild(info);

  // Dauer
  const dur = document.createElement('div');
  dur.className = 'session-duration';
  dur.textContent = session.duration_seconds
    ? formatDuration(session.duration_seconds / 60)
    : formatDuration(session.duration_minutes || session.minutes || 0);
  item.appendChild(dur);

  // Delete Button
  const delBtn = document.createElement('button');
  delBtn.className = 'btn-delete-entry';
  delBtn.textContent = '×';
  delBtn.title = 'Delete';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const data = await loadData();
    if (data.userState?.nonce && session.id) {
      try {
        await ajaxPost('jp343_delete_time_entry', {
          nonce: data.userState.nonce,
          entry_id: String(session.id)
        });
        item.remove();
      } catch { /* Loeschen fehlgeschlagen */ }
    }
  });
  item.appendChild(delBtn);

  return item;
}

// Sync CTA

function renderSyncCta(entries: PendingEntry[], userState: JP343UserState | null): void {
  const section = document.getElementById('syncSection');
  const container = document.getElementById('syncCta');
  if (!container || !section) return;
  container.textContent = '';

  // Eingeloggt: Section komplett ausblenden
  if (userState?.isLoggedIn) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';

  if (entries.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'Start watching Japanese content to see your stats here.';
    container.appendChild(p);
  } else {
    const p1 = document.createElement('p');
    p1.textContent = 'Your sessions are saved locally in this browser.';
    container.appendChild(p1);
    const p2 = document.createElement('p');
    p2.textContent = 'Login to sync across devices and keep your data safe.';
    container.appendChild(p2);
  }
}

// Tier Badge + Footer

function renderTierBadge(userState: JP343UserState | null): void {
  const badge = document.getElementById('tierBadge');
  if (!badge) return;

  badge.classList.remove('synced');
  if (userState?.isLoggedIn) {
    badge.textContent = 'Synced';
    badge.classList.add('synced');
  } else {
    badge.textContent = 'Local Only';
  }
}

async function renderAuthUI(userState: JP343UserState | null): Promise<void> {
  const userBar = document.getElementById('userBar');
  const authToggle = document.getElementById('authToggle');
  const loginDrawer = document.getElementById('loginDrawer');
  const userName = document.getElementById('userName');

  if (userState?.isLoggedIn) {
    if (userBar) userBar.style.display = 'flex';
    if (authToggle) authToggle.style.display = 'none';
    if (loginDrawer) { loginDrawer.style.display = 'none'; loginDrawer.classList.remove('open'); }
    const registerDrawer = document.getElementById('registerDrawer');
    if (registerDrawer) { registerDrawer.style.display = 'none'; registerDrawer.classList.remove('open'); }
    const stored = await browser.storage.local.get('jp343_extension_display_name');
    if (userName) userName.textContent = stored.jp343_extension_display_name || 'Connected';
  } else {
    if (userBar) userBar.style.display = 'none';
    if (authToggle) authToggle.style.display = '';
    if (loginDrawer) loginDrawer.style.display = '';
  }
}

function applyServerStats(serverData: Record<string, any>): void {
  if (serverData.total_seconds !== undefined) {
    renderHeroTime(serverData.total_seconds / 60);
  }
  if (serverData.week_seconds !== undefined) {
    setText('statWeek', formatStatDuration(serverData.week_seconds / 60));
  }
  if (serverData.today_seconds !== undefined) {
    setText('statToday', formatStatDuration(serverData.today_seconds / 60));
  }
  if (serverData.streak !== undefined) {
    setText('statStreak', `${serverData.streak}d`);
  }
}

function renderFooter(): void {
  const el = document.getElementById('dashboardFooter');
  if (el) el.textContent = `jp343 Extension v${browser.runtime.getManifest().version}`;
}

// Helpers

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove('skeleton');
    el.textContent = text;
  }
}

function showSessionsLoading(): void {
  const container = document.getElementById('sessionList');
  if (!container) return;
  container.textContent = '';
  const placeholder = document.createElement('div');
  placeholder.className = 'session-item skeleton';
  placeholder.style.height = '56px';
  placeholder.style.borderRadius = '8px';
  container.appendChild(placeholder);
}

// Main

async function refresh(): Promise<void> {
  if (isRefreshing) return;
  isRefreshing = true;

  try {
  const data = await loadData();
  const isLoggedIn = data.userState?.isLoggedIn && !!data.userState?.nonce;

  // Auth-UI + Heatmap immer sofort rendern
  renderHeatmap(data.stats.dailyMinutes);
  renderWeekBars(data.stats.dailyMinutes);
  renderSyncCta(data.entries, data.userState);
  renderTierBadge(data.userState);
  renderAuthUI(data.userState);
  renderFooter();

  renderStats(data.stats);

  if (isLoggedIn) {
    showSessionsLoading();

    const refreshed = await tryRefreshNonce(data.userState!);
    const activeState = refreshed || data.userState!;

    if (activeState.nonce) {
      const [serverStats, serverSessions] = await Promise.all([
        fetchServerStats(activeState),
        fetchServerSessions(activeState)
      ]);
      if (serverStats) {
        applyServerStats(serverStats);
      }
      if (serverSessions) {
        renderServerSessions(serverSessions);
      } else {
        renderSessions(data.entries);
      }
    } else {
      renderSessions(data.entries);
    }
    renderTierBadge(activeState);
    renderAuthUI(activeState);
  } else {
    renderSessions(data.entries);
  }

  } finally {
    isRefreshing = false;
  }
}

// Theme Toggle
function setupThemeToggle(): void {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;

  // Gespeicherten Theme laden
  const saved = localStorage.getItem('jp343_theme');
  if (saved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    btn.textContent = '\u2600'; // Sonne
  }

  btn.addEventListener('click', () => {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    if (isLight) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('jp343_theme', 'dark');
      btn.textContent = '\u263E'; // Mond
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('jp343_theme', 'light');
      btn.textContent = '\u2600'; // Sonne
    }
  });
}

// Initial render + Auth-UI setup
setupThemeToggle();
setupAuthUI();
refresh();

// Live-Update bei Storage-Aenderungen
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
