import type { PendingEntry, Platform, ActivityType } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { renderRecentlyDeleted } from './recently-deleted';
import { armDeleteButton } from './delete-confirm';
import { formatDuration, formatStatDuration, isValidImageUrl, formatSessionDate, getLocalDateString, getWeekDates } from '../../lib/format-utils';
import { subtractSessionFromServerStats } from '../../lib/server-stats';
import { ajaxPost } from './api';
import type { ServerSession, ServerStatsResponse } from './api';
import { getDayStartHour } from './stats';
import { setText, renderHeroTime, CACHED_SERVER_STATS_KEY } from './stats';

let sessionDisplayCount = 20;
let rawServerCache: ServerSession[] | null = null;
let cacheTimestamp = 0;
let serverSessionsExpanded = false;
const INITIAL_SERVER_SESSIONS = 5;
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;

const platformIcons: Record<string, string> = {
  youtube: '▶',
  netflix: 'N',
  crunchyroll: 'C',
  primevideo: 'P',
  disneyplus: 'D',
  cijapanese: '漢',
  nihongojikan: '時',
  spotify: '♪',
  twitch: 'T',
  asbplayer: 'A',
  mokuro: '本',
  ttu: '📗',
  generic: '⏵'
};

function requestRefresh(): void {
  document.dispatchEvent(new CustomEvent('jp343:refresh'));
}

function isRenamableSeries(projectId?: string): boolean {
  return !!projectId?.startsWith('ext_generic_cs_');
}

interface RenameResponse {
  success?: boolean;
  data?: { title?: string; pendingServerSync?: boolean };
  error?: string;
}

function attachSeriesRename(
  info: HTMLElement,
  titleEl: HTMLElement,
  projectId: string,
  getTitle: () => string,
  applyTitle: (title: string) => void
): void {
  const row = document.createElement('div');
  row.className = 'session-title-row';
  info.insertBefore(row, titleEl);
  row.appendChild(titleEl);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'session-rename-btn';
  btn.title = 'Rename series (applies to all sessions of this series)';
  btn.textContent = '✎';
  row.appendChild(btn);

  const status = document.createElement('span');
  status.className = 'session-rename-status';
  row.appendChild(status);

  let editing = false;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (editing) return;
    editing = true;
    const previousTitle = getTitle();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'session-rename-input';
    input.value = previousTitle;
    titleEl.style.display = 'none';
    btn.style.display = 'none';
    status.textContent = '';
    row.insertBefore(input, titleEl);

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'session-rename-reset';
    resetBtn.textContent = 'Reset';
    resetBtn.style.display = 'none';
    row.insertBefore(resetBtn, status);

    input.focus();
    input.select();

    let saving = false;
    const finish = (): void => {
      input.remove();
      resetBtn.remove();
      titleEl.style.display = '';
      btn.style.display = '';
      editing = false;
    };
    const showStatus = (text: string): void => {
      status.textContent = text;
      if (text) setTimeout(() => { if (status.textContent === text) status.textContent = ''; }, 4000);
    };
    const save = async (): Promise<void> => {
      if (saving) return;
      const newTitle = input.value.trim();
      if (!newTitle || newTitle === previousTitle) { finish(); return; }
      saving = true;
      input.disabled = true;
      try {
        const res = await browser.runtime.sendMessage({
          type: 'RENAME_CUSTOM_SITE_SERIES',
          projectId,
          title: newTitle,
          previousTitle
        }) as RenameResponse;
        if (res?.success) {
          applyTitle(res.data?.title ?? newTitle);
          showStatus(res.data?.pendingServerSync ? 'Saved, account sync pending' : '');
        } else {
          showStatus(res?.error || 'Rename failed');
        }
      } catch {
        showStatus('Rename failed');
      }
      finish();
    };
    input.addEventListener('blur', () => { void save(); });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); void save(); }
      if (ev.key === 'Escape') { input.value = previousTitle; finish(); }
    });

    void (async () => {
      try {
        const res = await browser.runtime.sendMessage({ type: 'CUSTOM_SITES_GET' }) as {
          success?: boolean;
          data?: { customSites?: { names?: Record<string, { originalLabel?: string }> } };
        };
        const videoId = projectId.slice('ext_generic_'.length);
        const original = res?.data?.customSites?.names?.[videoId]?.originalLabel;
        if (original && editing && !saving) {
          resetBtn.title = `Restore "${original}"`;
          resetBtn.style.display = '';
        }
      } catch { /* ignore */ }
    })();
    resetBtn.addEventListener('mousedown', (ev) => { ev.preventDefault(); });
    resetBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (saving) return;
      saving = true;
      input.disabled = true;
      resetBtn.disabled = true;
      try {
        const res = await browser.runtime.sendMessage({
          type: 'CUSTOM_SITE_NAME_RESET',
          projectId
        }) as RenameResponse;
        if (res?.success) {
          if (res.data?.title) applyTitle(res.data.title);
          showStatus(res.error || (res.data?.pendingServerSync ? 'Reset, account sync pending' : ''));
        } else {
          showStatus(res?.error || 'Reset failed');
        }
      } catch {
        showStatus('Reset failed');
      }
      finish();
    });
  });
}

export function resetSessionDisplayCount(): void {
  sessionDisplayCount = 20;
}

export function hasValidSessionCache(): boolean {
  return rawServerCache !== null && (Date.now() - cacheTimestamp) < CACHE_MAX_AGE_MS;
}

export function getCachedServerSessions(): ServerSession[] | null {
  if (!hasValidSessionCache()) return null;
  return rawServerCache;
}

export function cacheServerSessions(sessions: ServerSession[]): void {
  rawServerCache = sessions;
  cacheTimestamp = Date.now();
}

export function clearRawCache(): void {
  rawServerCache = null;
  cacheTimestamp = 0;
}

export function invalidateSessionCache(): void {
  rawServerCache = null;
  cacheTimestamp = 0;
  serverSessionsExpanded = false;
}

export function showSessionsLoading(): void {
  const container = document.getElementById('sessionList');
  if (!container) return;
  container.textContent = '';
  const placeholder = document.createElement('div');
  placeholder.className = 'session-item skeleton';
  placeholder.style.height = '56px';
  placeholder.style.borderRadius = '8px';
  container.appendChild(placeholder);
}

export function renderSessions(entries: PendingEntry[]): void {
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
    if (isRenamableSeries(entry.project_id)) {
      attachSeriesRename(info, titleEl, entry.project_id,
        () => entry.project,
        (t) => { entry.project = t; titleEl.textContent = t; });
    }

    const meta = document.createElement('div');
    meta.className = 'session-meta';

    const platform = document.createElement('span');
    platform.className = `session-platform platform-${entry.platform}`;
    platform.textContent = entry.platform;
    meta.appendChild(platform);

    if (entry.activityType && entry.activityType !== 'watching' && !(entry.platform === 'spotify' && entry.activityType === 'listening')) {
      const typeEl = document.createElement('span');
      typeEl.className = 'session-activity-type';
      typeEl.textContent = entry.activityType;
      meta.appendChild(typeEl);
    }

    const dateEl = document.createElement('span');
    dateEl.textContent = formatSessionDate(entry.date, getDayStartHour());
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
    armDeleteButton(delBtn, async () => {
      if (entry.synced && entry.serverEntryId) {
        const result = await browser.storage.local.get([STORAGE_KEYS.USER]);
        const userState = result[STORAGE_KEYS.USER];
        if (userState?.extApiToken || userState?.nonce) {
          try {
            if (userState.extApiToken) {
              const result = await ajaxPost('jp343_extension_delete_time_entry', {
                ext_api_token: userState.extApiToken,
                entry_id: String(entry.serverEntryId)
              });
              if (!result.success) return;
            } else {
              const result = await ajaxPost('jp343_delete_time_entry', {
                nonce: userState.nonce!,
                entry_id: String(entry.serverEntryId)
              });
              if (!result.success) return;
            }
          } catch { return; }
        }
      }
      await browser.runtime.sendMessage({ type: 'DELETE_PENDING_ENTRY', entryId: entry.id, entrySnapshot: entry });
      requestRefresh();
    });
    item.appendChild(delBtn);

    container.appendChild(item);
  }

  if (sorted.length > sessionDisplayCount) {
    const loadMore = document.createElement('button');
    loadMore.className = 'btn-sync-dashboard';
    loadMore.style.width = '100%';
    loadMore.style.marginTop = '12px';
    loadMore.textContent = `Show ${sorted.length - sessionDisplayCount} more sessions`;
    loadMore.addEventListener('click', () => {
      sessionDisplayCount += 20;
      requestRefresh();
    });
    container.appendChild(loadMore);
  }
}

function pendingToServerSession(entry: PendingEntry): ServerSession {
  return {
    id: entry.id,
    project_id: entry.project_id,
    title: entry.project,
    platform: entry.platform,
    duration_seconds: Math.round(entry.duration_min * 60),
    date: entry.date,
    image: entry.thumbnail || undefined,
    url: entry.url,
    activity_type: entry.activityType,
  };
}

function serverSessionToPendingEntry(session: ServerSession): PendingEntry {
  return {
    id: `server-${session.id}`,
    date: session.date || new Date().toISOString(),
    duration_min: (session.duration_seconds || 0) / 60,
    project: session.title || 'Session',
    project_id: session.project_id ?? '',
    platform: (session.platform || 'generic') as Platform,
    source: 'extension',
    url: session.url || '',
    thumbnail: session.image || null,
    synced: true,
    syncedAt: session.date || null,
    syncAttempts: 0,
    lastSyncError: null,
    serverEntryId: Number(session.id) || null,
    channelId: null,
    channelName: null,
    channelUrl: null,
    activityType: session.activity_type as ActivityType | undefined
  };
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
    ph.textContent = (session.platform && platformIcons[session.platform]) || session.icon || '⏵';
    item.appendChild(ph);
  }

  const info = document.createElement('div');
  info.className = 'session-info';

  const titleEl = session.url && /^https?:\/\//i.test(session.url)
    ? (() => { const a = document.createElement('a'); a.className = 'session-title session-title-link'; a.textContent = session.title!; a.href = session.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; })()
    : (() => { const d = document.createElement('div'); d.className = 'session-title'; d.textContent = session.title!; return d; })();
  info.appendChild(titleEl);
  if (isRenamableSeries(session.project_id)) {
    attachSeriesRename(info, titleEl, session.project_id!,
      () => session.title || '',
      (t) => {
        session.title = t;
        titleEl.textContent = t;
        if (rawServerCache) {
          rawServerCache = rawServerCache.map(s => s.project_id === session.project_id ? { ...s, title: t } : s);
        }
      });
  }

  const meta = document.createElement('div');
  meta.className = 'session-meta';

  if (session.platform && session.platform !== 'manual') {
    const platform = document.createElement('span');
    const actType = session.activity_type;
    if (session.platform === 'generic' && actType && actType !== 'watching' && actType !== 'other') {
      platform.className = 'session-platform session-activity-type';
      platform.textContent = actType;
    } else {
      platform.className = `session-platform platform-${session.platform}`;
      platform.textContent = session.platform;
    }
    meta.appendChild(platform);
  }

  if (session.activity_type && session.activity_type !== 'watching' && session.activity_type !== 'other' && session.platform !== 'generic' && !(session.platform === 'spotify' && session.activity_type === 'listening')) {
    const typeEl = document.createElement('span');
    typeEl.className = 'session-activity-type';
    typeEl.textContent = session.activity_type;
    meta.appendChild(typeEl);
  }

  const dateEl = document.createElement('span');
  dateEl.textContent = formatSessionDate(session.date, getDayStartHour());
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
  armDeleteButton(delBtn, async () => {
    const idStr = String(session.id ?? '');
    if (!idStr) return;
    if (!/^\d+$/.test(idStr)) {
      // Local entry shown in the merged list
      await browser.runtime.sendMessage({ type: 'DELETE_PENDING_ENTRY', entryId: idStr });
      requestRefresh();
      return;
    }
    const result = await browser.storage.local.get([STORAGE_KEYS.USER]);
    const userState = result[STORAGE_KEYS.USER];
    if (!userState?.extApiToken && !userState?.nonce) return;
    try {
      if (userState.extApiToken) {
        const res = await ajaxPost('jp343_extension_delete_time_entry', {
          ext_api_token: userState.extApiToken,
          entry_id: idStr
        });
        if (!res.success) return;
      } else {
        const res = await ajaxPost('jp343_delete_time_entry', {
          nonce: userState.nonce!,
          entry_id: idStr
        });
        if (!res.success) return;
      }
    } catch { return; }

    item.remove();
    if (rawServerCache) {
      rawServerCache = rawServerCache.filter(s => String(s.id) !== idStr);
    }
    const durationSec = session.duration_seconds || 0;
    if (durationSec > 0) {
      const cached: ServerStatsResponse | undefined =
        (await browser.storage.local.get(CACHED_SERVER_STATS_KEY))[CACHED_SERVER_STATS_KEY];
      if (cached) {
        const dsh = getDayStartHour();
        const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const tzMatch = !cached.timezone || cached.timezone === browserTz;
        const sessionDate = session.date ? getLocalDateString(new Date(session.date), dsh) : '';
        const today = getLocalDateString(new Date(), dsh);
        const weekDays = getWeekDates(dsh);
        const weekStart = weekDays[0]?.date ?? '';
        const weekEnd = weekDays[weekDays.length - 1]?.date ?? '';
        subtractSessionFromServerStats(cached, durationSec, sessionDate, today, weekStart, weekEnd, browserTz);
        if (cached.total_seconds !== undefined) renderHeroTime(cached.total_seconds / 60);
        if (sessionDate === today && tzMatch && cached.today_seconds !== undefined) {
          setText('statToday', formatStatDuration(cached.today_seconds / 60));
        }
        if (weekStart && sessionDate >= weekStart && sessionDate <= weekEnd) {
          const weekSec = cached.calendar_week_seconds ?? cached.week_seconds;
          if (weekSec !== undefined) setText('statWeek', formatStatDuration(weekSec / 60));
        }
      }
    }
    let notified = false;
    for (let attempt = 0; attempt < 2 && !notified; attempt++) {
      try {
        await browser.runtime.sendMessage({
          type: 'DELETE_PENDING_BY_SERVER_ID',
          serverEntryId: Number(idStr),
          entrySnapshot: serverSessionToPendingEntry(session)
        });
        notified = true;
      } catch { /* retry once */ }
    }
    void renderRecentlyDeleted();
  });
  item.appendChild(delBtn);

  return item;
}

export function renderServerSessions(sessions: ServerSession[], unsyncedLocal: PendingEntry[] = []): void {
  const container = document.getElementById('sessionList');
  if (!container) return;
  container.textContent = '';

  const localConverted = unsyncedLocal.map(pendingToServerSession);
  const serverIds = new Set(sessions.map(s => String(s.id)));
  const deduped = localConverted.filter(l => !serverIds.has(String(l.id)));
  const merged = [...deduped, ...sessions].sort(
    (a, b) => new Date(b.date || '').getTime() - new Date(a.date || '').getTime()
  );
  if (merged.length === 0) {
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

  const display = serverSessionsExpanded ? merged : merged.slice(0, INITIAL_SERVER_SESSIONS);
  const remaining = serverSessionsExpanded ? 0 : merged.length - INITIAL_SERVER_SESSIONS;

  for (const session of display) {
    container.appendChild(createServerSessionItem(session));
  }

  if (remaining > 0) {
    const showMore = document.createElement('button');
    showMore.className = 'btn-sync-dashboard';
    showMore.style.width = '100%';
    showMore.style.marginTop = '12px';
    showMore.textContent = `Show ${remaining} more sessions`;
    showMore.addEventListener('click', () => {
      serverSessionsExpanded = true;
      showMore.remove();
      for (const session of merged.slice(INITIAL_SERVER_SESSIONS)) {
        container.appendChild(createServerSessionItem(session));
      }
    });
    container.appendChild(showMore);
  }
}
