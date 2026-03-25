
import type { PendingEntry, ExtensionStats, JP343UserState, TrackingSession } from '../../types';
import { DEFAULT_STATS, STORAGE_KEYS } from '../../types';
import { formatStatDuration, formatDuration, isValidImageUrl, formatSessionDate, getLocalDateString, getWeekDates } from '../../lib/format-utils';

const AJAX_URL = 'https://jp343.com/wp-admin/admin-ajax.php';

interface ServerStatsResponse {
  total_seconds?: number;
  week_seconds?: number;
  today_seconds?: number;
  streak?: number;
  daily_avg_seconds?: number;
  daily_minutes?: Record<string, number>;
}

interface ServerSession {
  id: number | string;
  project_id?: string;
  project_name?: string;
  title?: string;
  icon?: string;
  color?: string;
  image?: string;
  platform?: string;
  duration_minutes?: number;
  minutes?: number;
  duration_seconds?: number;
  logged_at?: string;
  date?: string;
  relative?: string;
  notes?: string;
  has_notes?: boolean;
  resource_url?: string;
  url?: string;
}

let sessionDisplayCount = 20;

let _localDailyMinutes: Record<string, number> = {};

const platformIcons: Record<string, string> = {
  youtube: '▶',
  netflix: 'N',
  crunchyroll: 'C',
  primevideo: 'P',
  disneyplus: 'D',
  cijapanese: '漢',
  generic: '⏵'
};

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

async function ajaxPost(action: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
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
        extApiToken: result.data.extApiToken || userState.extApiToken || null,
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

    let result: { success: boolean; data?: Record<string, unknown> };
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
        ajaxUrl: (result.data.ajaxUrl && /^https:\/\/(.*\.)?jp343\.com\//i.test(result.data.ajaxUrl)) ? result.data.ajaxUrl : AJAX_URL,
        guestToken: null,
        extApiToken: result.data.extApiToken || null
      };
      await browser.storage.local.set({
        [STORAGE_KEYS.USER]: userState,
        jp343_extension_display_name: result.data.displayName || null
      });

      try {
        await browser.runtime.sendMessage({ type: 'SYNC_ENTRIES_DIRECT' });
      } catch { /* Sync failure must not block login */ }

      return { success: true, userState };
    }

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

async function fetchServerStats(userState: JP343UserState): Promise<ServerStatsResponse | null> {
  if (userState.extApiToken) {
    try {
      const result = await ajaxPost('jp343_extension_get_time_stats', {
        ext_api_token: userState.extApiToken
      });
      if (result.success) return result.data;
    } catch {}
  }
  if (userState.nonce) {
    try {
      const result = await ajaxPost('jp343_get_time_stats', { nonce: userState.nonce });
      if (result.success) return result.data;
    } catch {}
  }
  return null;
}

function normalizeServerSessions(raw: ServerSession[]): ServerSession[] {
  return raw.map(s => ({
    ...s,
    title: s.title || s.project_name || 'Session',
    date: s.date || s.logged_at || '',
    duration_seconds: s.duration_seconds ?? (s.duration_minutes ?? s.minutes ?? 0) * 60,
    url: s.resource_url || s.url || undefined,
  }));
}

// Fetch sessions via token or cookies
async function fetchServerSessions(userState: JP343UserState, limit = 20): Promise<ServerSession[] | null> {
  if (userState.extApiToken) {
    try {
      const result = await ajaxPost('jp343_extension_get_recent_sessions', {
        ext_api_token: userState.extApiToken,
        limit: String(limit)
      });
      if (result.success && result.data?.sessions) return normalizeServerSessions(result.data.sessions);
    } catch {}
  }
  if (userState.nonce) {
    try {
      const result = await ajaxPost('jp343_get_recent_sessions', {
        nonce: userState.nonce,
        limit: String(limit)
      });
      if (result.success && result.data?.sessions) return normalizeServerSessions(result.data.sessions);
    } catch {}
  }
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

    let result: { success: boolean; data?: Record<string, unknown> };
    try { result = JSON.parse(text); } catch {
      return { success: false, error: `Server returned non-JSON (${response.status})` };
    }

    if (result.success && result.data?.nonce) {
      const userState: JP343UserState = {
        isLoggedIn: true,
        userId: result.data.userId,
        nonce: result.data.nonce,
        ajaxUrl: (result.data.ajaxUrl && /^https:\/\/(.*\.)?jp343\.com\//i.test(result.data.ajaxUrl)) ? result.data.ajaxUrl : AJAX_URL,
        guestToken: null,
        extApiToken: result.data.extApiToken || null
      };
      await browser.storage.local.set({
        [STORAGE_KEYS.USER]: userState,
        jp343_extension_display_name: result.data.displayName || null
      });

      // Auto-sync after registration
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

  const activeDays = Object.values(stats.dailyMinutes).filter(m => m > 0).length;
  if (activeDays > 0) {
    const dailyAvg = stats.totalMinutes / activeDays;
    setText('statDailyAvg', formatStatDuration(Math.round(dailyAvg)));

    const activeWeeks = new Set<string>();
    for (const date of Object.keys(stats.dailyMinutes)) {
      if (stats.dailyMinutes[date] > 0) {
        const d = new Date(date + 'T00:00:00');
        const weekStart = new Date(d);
        weekStart.setDate(d.getDate() - d.getDay());
        activeWeeks.add(weekStart.toISOString().slice(0, 10));
      }
    }
    if (activeWeeks.size > 0) {
      setText('statWeeklyAvg', formatStatDuration(Math.round(stats.totalMinutes / activeWeeks.size)));
    }

    const activeMonths = new Set<string>();
    for (const date of Object.keys(stats.dailyMinutes)) {
      if (stats.dailyMinutes[date] > 0) {
        activeMonths.add(date.slice(0, 7));
      }
    }
    if (activeMonths.size > 0) {
      setText('statMonthlyAvg', formatStatDuration(Math.round(stats.totalMinutes / activeMonths.size)));
    }

    const bestDay = Math.max(...Object.values(stats.dailyMinutes));
    if (bestDay > 0) {
      setText('statBestDay', formatStatDuration(Math.round(bestDay)));
    }
  }
}

function renderHeatmap(dailyMinutes: Record<string, number>): void {
  const container = document.getElementById('heatmap');
  if (!container) return;
  container.textContent = '';

  const today = new Date();
  const todayDayOfWeek = (today.getDay() + 6) % 7; // 0=Mon
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const WEEKS = 52;

  // Build 52 weeks with Monday as start day
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - todayDayOfWeek - 51 * 7);

  const allWeeks: { date: Date; dateStr: string }[][] = [];
  for (let w = 0; w < WEEKS; w++) {
    const week: { date: Date; dateStr: string }[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(startDate);
      date.setDate(startDate.getDate() + w * 7 + d);
      week.push({ date, dateStr: getLocalDateString(date) });
    }
    allWeeks.push(week);
  }

  // Group weeks by month of their Monday
  const groupMap = new Map<string, { label: string; weeks: typeof allWeeks }>();
  allWeeks.forEach(week => {
    const mon = week[0].date;
    const key = `${mon.getFullYear()}-${mon.getMonth()}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, { label: MONTH_NAMES[mon.getMonth()], weeks: [] });
    }
    groupMap.get(key)!.weeks.push(week);
  });

  const body = document.createElement('div');
  body.className = 'heatmap-body';

  const dayLabelsEl = document.createElement('div');
  dayLabelsEl.className = 'heatmap-day-labels';
  dayLabelsEl.appendChild(document.createElement('span'));
  ['Mo', '', 'Mi', '', 'Fr', '', ''].forEach(label => {
    const span = document.createElement('span');
    span.textContent = label;
    dayLabelsEl.appendChild(span);
  });
  dayLabelsEl.appendChild(document.createElement('span'));

  const monthsRow = document.createElement('div');
  monthsRow.className = 'heatmap-months-row';

  groupMap.forEach(({ label, weeks }) => {
    const group = document.createElement('div');
    group.className = 'heatmap-month-group';

    const labelEl = document.createElement('span');
    labelEl.className = 'heatmap-month-label';
    labelEl.textContent = label;

    const grid = document.createElement('div');
    grid.className = 'heatmap-month-grid';

    let activeDays = 0;

    weeks.forEach(week => {
      week.forEach(({ date, dateStr }) => {
        const cell = document.createElement('div');
        cell.className = 'heatmap-cell';
        if (date > today) {
          cell.style.visibility = 'hidden';
        } else {
          const minutes = dailyMinutes[dateStr] || 0;
          if (minutes > 0) activeDays++;
          const level = minutes === 0 ? 0 : minutes < 30 ? 1 : minutes < 60 ? 2 : minutes < 120 ? 3 : 4;
          cell.dataset.level = String(level);
          cell.title = `${dateStr}: ${formatStatDuration(minutes)}`;
          cell.setAttribute('aria-label', `${dateStr}: ${formatStatDuration(minutes)}`);
        }
        grid.appendChild(cell);
      });
    });

    const activeEl = document.createElement('span');
    activeEl.className = 'heatmap-month-active' + (activeDays > 0 ? ' has-data' : '');
    activeEl.textContent = activeDays > 0 ? `${activeDays}d` : '';
    activeEl.title = activeDays > 0 ? `${activeDays} active days` : 'No activity';

    group.appendChild(labelEl);
    group.appendChild(grid);
    group.appendChild(activeEl);
    monthsRow.appendChild(group);
  });

  body.appendChild(dayLabelsEl);
  body.appendChild(monthsRow);
  container.appendChild(body);
}

function renderWeekBars(dailyMinutes: Record<string, number>): void {
  const container = document.getElementById('weekBars');
  if (!container) return;
  container.textContent = '';

  const days = getWeekDates();
  const maxMin = Math.max(1, ...days.map(d => dailyMinutes[d.date] || 0));

  const BAR_MAX_PX = 64;

  for (const day of days) {
    const min = dailyMinutes[day.date] || 0;
    const heightPx = Math.max(2, Math.round((min / maxMin) * BAR_MAX_PX));

    const col = document.createElement('div');
    col.className = 'week-bar-col';

    const value = document.createElement('div');
    value.className = 'week-bar-value';
    value.textContent = min > 0 ? formatStatDuration(min) : '';

    const bar = document.createElement('div');
    bar.className = `week-bar${day.isToday ? ' today' : ''}`;
    bar.style.height = `${heightPx}px`;

    const label = document.createElement('div');
    label.className = 'week-bar-label';
    label.textContent = day.label;

    col.appendChild(value);
    col.appendChild(bar);
    col.appendChild(label);
    container.appendChild(col);
  }
}

function renderMonthBars(dailyMinutes: Record<string, number>): void {
  const container = document.getElementById('monthBars');
  if (!container) return;
  container.textContent = '';

  const now = new Date();
  const months: { key: string; label: string; minutes: number; isCurrent: boolean }[] = [];
  const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Last 6 months including current
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = d.getFullYear();
    const month = d.getMonth();
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;

    let total = 0;
    for (const [date, min] of Object.entries(dailyMinutes)) {
      if (date.startsWith(prefix)) total += min;
    }

    months.push({
      key: prefix,
      label: monthLabels[month],
      minutes: total,
      isCurrent: i === 0
    });
  }

  const maxMin = Math.max(1, ...months.map(m => m.minutes));

  const BAR_MAX_PX = 64;

  for (const month of months) {
    const heightPx = Math.max(2, Math.round((month.minutes / maxMin) * BAR_MAX_PX));

    const col = document.createElement('div');
    col.className = 'month-bar-col';

    const value = document.createElement('div');
    value.className = 'month-bar-value';
    value.textContent = month.minutes > 0 ? formatStatDuration(month.minutes) : '';

    const bar = document.createElement('div');
    bar.className = `month-bar${month.isCurrent ? ' current' : ''}`;
    bar.style.height = `${heightPx}px`;

    const label = document.createElement('div');
    label.className = 'month-bar-label';
    label.textContent = month.label;

    col.appendChild(value);
    col.appendChild(bar);
    col.appendChild(label);
    container.appendChild(col);
  }
}

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

    const info = document.createElement('div');
    info.className = 'session-info';

    const titleEl = entry.url && /^https?:\/\//i.test(entry.url)
      ? (() => { const a = document.createElement('a'); a.className = 'session-title session-title-link'; a.textContent = entry.project; a.href = entry.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; })()
      : (() => { const d = document.createElement('div'); d.className = 'session-title'; d.textContent = entry.project; return d; })();
    info.appendChild(titleEl);

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

    const dur = document.createElement('div');
    dur.className = 'session-duration';
    dur.textContent = formatDuration(entry.duration_min);
    item.appendChild(dur);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-delete-entry';
    delBtn.textContent = '×';
    delBtn.title = 'Delete';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (entry.synced && entry.serverEntryId) {
        const data = await loadData();
        if (data.userState?.extApiToken || data.userState?.nonce) {
          try {
            if (data.userState.extApiToken) {
              await ajaxPost('jp343_extension_delete_time_entry', {
                ext_api_token: data.userState.extApiToken,
                entry_id: String(entry.serverEntryId)
              });
            } else {
              await ajaxPost('jp343_delete_time_entry', {
                nonce: data.userState.nonce!,
                entry_id: String(entry.serverEntryId)
              });
            }
          } catch { /* Server delete failed — still clean up locally */ }
        }
      }
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

let serverSessionsCache: ServerSession[] | null = null;
const INITIAL_SERVER_SESSIONS = 5;

function renderServerSessions(sessions: ServerSession[]): void {
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

function createServerSessionItem(session: ServerSession): HTMLElement {
  const item = document.createElement('div');
  item.className = 'session-item';

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

  const info = document.createElement('div');
  info.className = 'session-info';

  const titleEl = session.url && /^https?:\/\//i.test(session.url)
    ? (() => { const a = document.createElement('a'); a.className = 'session-title session-title-link'; a.textContent = session.title!; a.href = session.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; })()
    : (() => { const d = document.createElement('div'); d.className = 'session-title'; d.textContent = session.title!; return d; })();
  info.appendChild(titleEl);

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

  const dur = document.createElement('div');
  dur.className = 'session-duration';
  dur.textContent = formatDuration((session.duration_seconds || 0) / 60);
  item.appendChild(dur);

  const delBtn = document.createElement('button');
  delBtn.className = 'btn-delete-entry';
  delBtn.textContent = '×';
  delBtn.title = 'Delete';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const data = await loadData();
    if ((data.userState?.extApiToken || data.userState?.nonce) && session.id) {
      try {
        if (data.userState.extApiToken) {
          await ajaxPost('jp343_extension_delete_time_entry', {
            ext_api_token: data.userState.extApiToken,
            entry_id: String(session.id)
          });
        } else {
          await ajaxPost('jp343_delete_time_entry', {
            nonce: data.userState.nonce!,
            entry_id: String(session.id)
          });
        }
        item.remove();
      } catch { /* Delete failed */ }
    }
  });
  item.appendChild(delBtn);

  return item;
}

function renderSyncCta(entries: PendingEntry[], userState: JP343UserState | null): void {
  const section = document.getElementById('syncSection');
  const container = document.getElementById('syncCta');
  if (!container || !section) return;
  container.textContent = '';

  // Logged in: hide sync CTA entirely
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

const CACHED_SERVER_STATS_KEY = 'jp343_cached_server_stats';

function mergeDailyMinutes(
  local: Record<string, number>,
  server: Record<string, number>
): Record<string, number> {
  const merged: Record<string, number> = { ...server };
  for (const [date, localMin] of Object.entries(local)) {
    if (localMin > (merged[date] ?? 0)) merged[date] = localMin;
  }
  return merged;
}

function applyDerivedStats(dailyMinutes: Record<string, number>): void {
  const now = new Date();
  const thisMonthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  let totalMin = 0;
  let monthMin = 0;
  let bestDay = 0;
  const activeWeeks = new Set<string>();
  const activeMonths = new Set<string>();

  for (const [date, min] of Object.entries(dailyMinutes)) {
    if (min <= 0) continue;
    totalMin += min;
    if (date.startsWith(thisMonthPrefix)) monthMin += min;
    if (min > bestDay) bestDay = min;
    const d = new Date(date + 'T12:00:00');
    const startOfYear = new Date(d.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((d.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
    activeWeeks.add(`${d.getFullYear()}-W${weekNum}`);
    activeMonths.add(date.slice(0, 7));
  }

  setText('statMonth', formatStatDuration(monthMin));
  setText('statBestDay', formatStatDuration(bestDay));
  if (activeWeeks.size > 0)
    setText('statWeeklyAvg', formatStatDuration(Math.round(totalMin / activeWeeks.size)));
  if (activeMonths.size > 0)
    setText('statMonthlyAvg', formatStatDuration(Math.round(totalMin / activeMonths.size)));
}

function applyServerStats(serverData: ServerStatsResponse): void {
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
  if (serverData.daily_avg_seconds !== undefined) {
    setText('statDailyAvg', formatStatDuration(serverData.daily_avg_seconds / 60));
  }
  if (serverData.daily_minutes) {
    const merged = mergeDailyMinutes(_localDailyMinutes, serverData.daily_minutes);
    renderHeatmap(merged);
    renderWeekBars(merged);
    renderMonthBars(merged);
    applyDerivedStats(merged);
  }
  browser.storage.local.set({ [CACHED_SERVER_STATS_KEY]: serverData });
}

async function applyCachedServerStats(): Promise<void> {
  const cached = (await browser.storage.local.get(CACHED_SERVER_STATS_KEY))[CACHED_SERVER_STATS_KEY];
  if (cached) {
    applyServerStats(cached);
  }
}

function renderFooter(): void {
  const el = document.getElementById('dashboardFooter');
  if (!el) return;

  const version = document.createElement('span');
  version.textContent = `jp343 Extension v${browser.runtime.getManifest().version}`;

  const links = document.createElement('div');
  links.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:10px;margin-top:6px;';

  const discord = document.createElement('a');
  discord.href = 'https://discord.gg/EA2A93DY';
  discord.target = '_blank';
  discord.title = 'Join our Discord';
  discord.style.cssText = 'color:var(--accent, #e84393);opacity:0.8;transition:opacity 0.2s;display:flex;align-items:center;';
  discord.onmouseover = () => { discord.style.opacity = '1'; };
  discord.onmouseout = () => { discord.style.opacity = '0.5'; };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 127.14 96.36');
  svg.setAttribute('fill', 'currentColor');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z');
  svg.appendChild(path);
  discord.appendChild(svg);

  const site = document.createElement('a');
  site.href = 'https://jp343.com';
  site.target = '_blank';
  site.textContent = 'jp343.com';
  site.style.cssText = 'color:var(--text-secondary);opacity:0.7;font-size:11px;text-decoration:none;transition:opacity 0.2s;';
  site.onmouseover = () => { site.style.opacity = '1'; };
  site.onmouseout = () => { site.style.opacity = '0.5'; };

  links.appendChild(discord);
  links.appendChild(site);
  el.textContent = '';
  el.appendChild(version);
  el.appendChild(links);
}

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

async function refresh(): Promise<void> {
  if (isRefreshing) return;
  isRefreshing = true;

  try {
  const data = await loadData();
  _localDailyMinutes = { ...data.stats.dailyMinutes };
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
    showSessionsLoading();

    const refreshed = await tryRefreshNonce(data.userState!);
    const activeState = refreshed || data.userState!;

    if (activeState.nonce || activeState.extApiToken) {
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
    renderStats(data.stats);
    renderSessions(data.entries);
  }

  } finally {
    isRefreshing = false;
  }
}

function setupThemeToggle(): void {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;

  const saved = localStorage.getItem('jp343_theme');
  if (saved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    btn.textContent = '\u2600';
  }

  btn.addEventListener('click', () => {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    if (isLight) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('jp343_theme', 'dark');
      btn.textContent = '\u263E';
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('jp343_theme', 'light');
      btn.textContent = '\u2600';
    }
  });
}

setupThemeToggle();
setupAuthUI();
refresh();

// Live-update on storage changes
browser.storage.onChanged.addListener((changes, area) => {
  if (isLoggingOut) return; // Logout in progress — skip re-refresh
  if (area === 'local' && (
    changes[STORAGE_KEYS.PENDING] ||
    changes[STORAGE_KEYS.STATS] ||
    changes[STORAGE_KEYS.USER]
  )) {
    refresh();
  }
});
