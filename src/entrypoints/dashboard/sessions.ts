import type { PendingEntry, ActivityType } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { formatDuration, formatStatDuration, isValidImageUrl, formatSessionDate, getLocalDateString, getWeekDates } from '../../lib/format-utils';
import { ajaxPost } from './api';
import type { ServerSession, ServerStatsResponse } from './api';
import { setText, renderHeroTime, CACHED_SERVER_STATS_KEY } from './stats';

let sessionDisplayCount = 20;
let serverSessionsCache: ServerSession[] | null = null;
const INITIAL_SERVER_SESSIONS = 5;

const platformIcons: Record<string, string> = {
  youtube: '▶',
  netflix: 'N',
  crunchyroll: 'C',
  primevideo: 'P',
  disneyplus: 'D',
  cijapanese: '漢',
  spotify: '♪',
  generic: '⏵'
};

function requestRefresh(): void {
  document.dispatchEvent(new CustomEvent('jp343:refresh'));
}

export function resetSessionDisplayCount(): void {
  sessionDisplayCount = 20;
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
        const result = await browser.storage.local.get([STORAGE_KEYS.USER]);
        const userState = result[STORAGE_KEYS.USER];
        if (userState?.extApiToken || userState?.nonce) {
          try {
            if (userState.extApiToken) {
              await ajaxPost('jp343_extension_delete_time_entry', {
                ext_api_token: userState.extApiToken,
                entry_id: String(entry.serverEntryId)
              });
            } else {
              await ajaxPost('jp343_delete_time_entry', {
                nonce: userState.nonce!,
                entry_id: String(entry.serverEntryId)
              });
            }
          } catch {}
        }
      }
      await browser.runtime.sendMessage({ type: 'DELETE_PENDING_ENTRY', entryId: entry.id });
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
    loadMore.textContent = `Load More (${sorted.length - sessionDisplayCount} remaining)`;
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
    title: entry.project,
    platform: entry.platform,
    duration_seconds: Math.round(entry.duration_min * 60),
    date: entry.date,
    image: entry.thumbnail || undefined,
    url: entry.url,
    activity_type: entry.activityType,
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
    item.remove();
    const durationSec = session.duration_seconds || 0;
    if (durationSec > 0) {
      const cached: ServerStatsResponse | undefined =
        (await browser.storage.local.get(CACHED_SERVER_STATS_KEY))[CACHED_SERVER_STATS_KEY];
      if (cached) {
        if (cached.total_seconds) {
          cached.total_seconds -= durationSec;
          renderHeroTime(cached.total_seconds / 60);
        }
        const sessionDate = session.date ? getLocalDateString(new Date(session.date)) : '';
        const today = getLocalDateString();
        if (sessionDate === today && cached.today_seconds) {
          cached.today_seconds -= durationSec;
          setText('statToday', formatStatDuration(cached.today_seconds / 60));
        }
        const { start: weekStart, end: weekEnd } = getWeekDates();
        if (sessionDate >= weekStart && sessionDate <= weekEnd && cached.week_seconds) {
          cached.week_seconds -= durationSec;
          setText('statWeek', formatStatDuration(cached.week_seconds / 60));
        }
        browser.storage.local.set({ [CACHED_SERVER_STATS_KEY]: cached });
      }
    }
    const result = await browser.storage.local.get([STORAGE_KEYS.USER]);
    const userState = result[STORAGE_KEYS.USER];
    if ((userState?.extApiToken || userState?.nonce) && session.id) {
      try {
        if (userState.extApiToken) {
          await ajaxPost('jp343_extension_delete_time_entry', {
            ext_api_token: userState.extApiToken,
            entry_id: String(session.id)
          });
        } else {
          await ajaxPost('jp343_delete_time_entry', {
            nonce: userState.nonce!,
            entry_id: String(session.id)
          });
        }
      } catch {}
    }
    if (session.id) {
      browser.runtime.sendMessage({
        type: 'DELETE_PENDING_BY_SERVER_ID',
        serverEntryId: Number(session.id)
      }).catch(() => {});
    }
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
  serverSessionsCache = merged;

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

  const display = merged.slice(0, INITIAL_SERVER_SESSIONS);
  const remaining = merged.length - INITIAL_SERVER_SESSIONS;

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
      for (const session of merged.slice(INITIAL_SERVER_SESSIONS)) {
        container.appendChild(createServerSessionItem(session));
      }
    });
    container.appendChild(showMore);
  }
}
