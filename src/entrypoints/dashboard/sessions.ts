import type { PendingEntry, Platform, ActivityType } from '../../types';
import { PLATFORM_ICONS } from '../../lib/platform-labels';
import { activityAllowsPassive } from '../../types';
import { renderRecentlyDeleted } from './recently-deleted';
import { armConfirmButton } from './delete-confirm';
import { formatDuration, formatStatDuration, isValidImageUrl, formatSessionStart, earliestIsoDate, getLocalDateString, getWeekDates } from '../../lib/format-utils';
import { subtractSessionFromServerStats } from '../../lib/server-stats';
import type { ServerSession } from './api';
import { getDayStartHour, isAttentionDisplayEnabled } from './stats';
import { setText, renderHeroTime, readCachedServerStats } from './stats';
import { showStatus as showBulkStatus } from './settings-helpers';

let sessionDisplayCount = 20;
let rawServerCache: ServerSession[] | null = null;
let cacheTimestamp = 0;
let serverSessionsExpanded = false;
let bulkTagExpanded = false;
let bulkTagBusy = false;
const INITIAL_SERVER_SESSIONS = 5;
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;

function requestRefresh(): void {
  document.dispatchEvent(new CustomEvent('jp343:refresh'));
}

async function requestServerEntryDelete(serverEntryId: number, snapshot: PendingEntry): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await browser.runtime.sendMessage({
        type: 'DELETE_SERVER_ENTRY',
        serverEntryId,
        entrySnapshot: snapshot
      }) as { success?: boolean; applied?: boolean } | undefined;
      return response?.success === true && response.applied === true;
    } catch { /* lost message response, retry is safe */ }
  }
  return false;
}

interface RetagResponse {
  success?: boolean;
  error?: string;
  updated?: number;
}

async function requestRetagPendingEntry(entryId: string, isPassive: boolean): Promise<RetagResponse | undefined> {
  try {
    return await browser.runtime.sendMessage({ type: 'RETAG_ENTRY', entryId, isPassive }) as RetagResponse | undefined;
  } catch {
    return { success: false, error: 'Retag failed' };
  }
}

async function requestRetagServerEntry(session: ServerSession, isPassive: boolean): Promise<RetagResponse | undefined> {
  const idStr = String(session.id ?? '');
  try {
    if (/^\d+$/.test(idStr)) {
      return await browser.runtime.sendMessage({ type: 'RETAG_ENTRY', serverEntryId: session.id, isPassive }) as RetagResponse | undefined;
    }
    return await browser.runtime.sendMessage({ type: 'RETAG_ENTRY', entryId: idStr, isPassive }) as RetagResponse | undefined;
  } catch {
    return { success: false, error: 'Retag failed' };
  }
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

interface AttentionAggregate {
  activeMin: number;
  passiveMin: number;
  totalMin: number;
  tagged: boolean;
}

function historyGroupKey(projectKey: string, dateStr: string | undefined, tagged: boolean): string {
  const day = dateStr ? getLocalDateString(new Date(dateStr), getDayStartHour()) : '';
  return `${projectKey}|${day}|${tagged ? 't' : 'u'}`;
}

async function retagSequentially<T>(
  items: T[],
  isPassive: boolean,
  retag: (item: T, isPassive: boolean) => Promise<RetagResponse | undefined>
): Promise<RetagResponse | undefined> {
  let last: RetagResponse | undefined = { success: true };
  for (const item of items) {
    last = await retag(item, isPassive);
    if (!last?.success) return last;
  }
  return last;
}

function buildAttentionBar(agg: AttentionAggregate): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'session-attention-bar';
  if (agg.activeMin > 0) {
    const seg = document.createElement('div');
    seg.className = 'att-seg-active';
    seg.style.flexGrow = String(agg.activeMin);
    bar.appendChild(seg);
  }
  if (agg.passiveMin > 0) {
    const seg = document.createElement('div');
    seg.className = 'att-seg-passive';
    seg.style.flexGrow = String(agg.passiveMin);
    bar.appendChild(seg);
  }
  return bar;
}

function attachAttentionLabels(
  meta: HTMLElement,
  item: HTMLElement,
  agg: AttentionAggregate,
  activityType: ActivityType | undefined,
  retagMode: (mode: 'active' | 'passive', targetIsPassive: boolean) => Promise<RetagResponse | undefined>
): void {
  const addLabel = (mode: 'active' | 'passive', minutes: number): void => {
    const label = document.createElement('button');
    label.type = 'button';
    label.className = `session-att-label att-${mode}`;
    label.textContent = `${formatDuration(minutes)} ${mode}`;
    const locked = mode === 'active' && !activityAllowsPassive(activityType);
    if (locked) {
      label.disabled = true;
      label.title = 'Reading and speaking sessions are always active';
    } else {
      const idleLabel = `${formatDuration(minutes)} ${mode}`;
      const target = mode === 'active' ? 'passive' : 'active';
      const idleTitle = `Retag this ${mode} time as ${target}`;
      label.title = idleTitle;
      armConfirmButton(label, async () => {
        label.disabled = true;
        const res = await retagMode(mode, mode === 'active');
        if (res?.success) {
          requestRefresh();
          return;
        }
        label.textContent = 'Failed';
        setTimeout(() => { label.textContent = idleLabel; label.disabled = false; }, 1500);
      }, {
        idleLabel,
        idleTitle,
        armedLabel: `${formatDuration(minutes)} → ${target}?`,
        armedTitle: 'Click again to confirm, the original split cannot be restored'
      });
    }
    meta.appendChild(label);
  };
  if (agg.activeMin > 0) addLabel('active', agg.activeMin);
  if (agg.activeMin > 0 && agg.passiveMin > 0) {
    const sep = document.createElement('span');
    sep.className = 'session-att-sep';
    sep.textContent = '·';
    meta.appendChild(sep);
  }
  if (agg.passiveMin > 0) addLabel('passive', agg.passiveMin);
  item.classList.add('has-attention-bar');
  item.appendChild(buildAttentionBar(agg));
}

interface ServerSessionGroup {
  first: ServerSession;
  members: ServerSession[];
  agg: AttentionAggregate;
}

function groupServerSessions(sessions: ServerSession[]): ServerSessionGroup[] {
  const byKey = new Map<string, ServerSessionGroup>();
  const groups: ServerSessionGroup[] = [];
  for (const s of sessions) {
    const tagged = s.isPassive !== undefined;
    const key = historyGroupKey(s.project_id || s.title || '', s.date, tagged);
    let group = byKey.get(key);
    if (!group) {
      group = { first: s, members: [], agg: { activeMin: 0, passiveMin: 0, totalMin: 0, tagged } };
      byKey.set(key, group);
      groups.push(group);
    }
    group.members.push(s);
    const min = (s.duration_seconds || 0) / 60;
    group.agg.totalMin += min;
    if (s.isPassive === true) group.agg.passiveMin += min;
    else if (s.isPassive === false) group.agg.activeMin += min;
  }
  return groups;
}

interface PendingGroup {
  first: PendingEntry;
  members: PendingEntry[];
  agg: AttentionAggregate;
}

function groupPendingEntries(entries: PendingEntry[]): PendingGroup[] {
  const byKey = new Map<string, PendingGroup>();
  const groups: PendingGroup[] = [];
  for (const entry of entries) {
    const tagged = entry.isPassive !== undefined;
    const key = historyGroupKey(`${entry.project_id}|${entry.project}`, entry.date, tagged);
    let group = byKey.get(key);
    if (!group) {
      group = { first: entry, members: [], agg: { activeMin: 0, passiveMin: 0, totalMin: 0, tagged } };
      byKey.set(key, group);
      groups.push(group);
    }
    group.members.push(entry);
    group.agg.totalMin += entry.duration_min;
    if (entry.isPassive === true) group.agg.passiveMin += entry.duration_min;
    else if (entry.isPassive === false) group.agg.activeMin += entry.duration_min;
  }
  return groups;
}

function createBulkTagToolbar(): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.className = 'session-bulk-toolbar';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'session-bulk-trigger';
  trigger.textContent = 'Tag untagged…';
  trigger.disabled = bulkTagBusy;
  toolbar.appendChild(trigger);

  const panel = document.createElement('div');
  panel.className = 'session-bulk-panel';
  panel.style.display = bulkTagExpanded ? 'flex' : 'none';
  toolbar.appendChild(panel);

  function setBusy(busy: boolean): void {
    bulkTagBusy = busy;
    trigger.disabled = busy;
    for (const btn of Array.from(panel.querySelectorAll('button'))) {
      (btn as HTMLButtonElement).disabled = busy;
    }
  }

  function makeOption(label: string, isPassive: boolean): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'session-bulk-option';
    btn.textContent = label;
    armConfirmButton(btn, async () => {
      if (bulkTagBusy) return;
      setBusy(true);
      let res: RetagResponse | undefined;
      try {
        res = await browser.runtime.sendMessage({ type: 'BULK_RETAG_UNTAGGED', isPassive }) as RetagResponse | undefined;
      } catch {
        res = { success: false, error: 'Bulk retag failed' };
      }
      setBusy(false);
      if (res?.success) {
        const resultLabel = typeof res.updated === 'number' ? `${res.updated} entries tagged` : 'Entries tagged';
        showBulkStatus(toolbar, resultLabel, 'success');
        bulkTagExpanded = false;
        panel.style.display = 'none';
        setTimeout(requestRefresh, 1200);
      } else {
        showBulkStatus(toolbar, res?.error || 'Bulk retag failed', 'error');
      }
    }, {
      idleLabel: label,
      idleTitle: 'Cannot be undone',
      armedLabel: 'Sure? Cannot be undone',
      armedTitle: 'Click again to confirm'
    });
    btn.title = 'Cannot be undone';
    return btn;
  }

  panel.appendChild(makeOption('All untagged → Active', false));
  panel.appendChild(makeOption('All untagged → Passive', true));

  trigger.addEventListener('click', () => {
    bulkTagExpanded = !bulkTagExpanded;
    panel.style.display = bulkTagExpanded ? 'flex' : 'none';
  });

  return toolbar;
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
  const groups = groupPendingEntries(sorted);
  const display = groups.slice(0, sessionDisplayCount);

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
  if (isAttentionDisplayEnabled()) container.appendChild(createBulkTagToolbar());

  for (const group of display) {
    const entry = group.first;
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
      ph.textContent = PLATFORM_ICONS[entry.platform] || '⏵';
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
    dateEl.textContent = formatSessionStart(earliestIsoDate(group.members.map(m => m.date)), getDayStartHour());
    meta.appendChild(dateEl);

    if (isAttentionDisplayEnabled() && group.agg.tagged) {
      attachAttentionLabels(meta, item, group.agg, entry.activityType, (mode, targetIsPassive) => {
        const targets = group.members.filter(m => m.isPassive === (mode === 'passive'));
        return retagSequentially(targets, targetIsPassive, (m, v) => requestRetagPendingEntry(m.id, v)).then(res => {
          if (res?.success) for (const m of targets) m.isPassive = targetIsPassive;
          return res;
        });
      });
    }

    info.appendChild(meta);
    item.appendChild(info);

    const dur = document.createElement('div');
    dur.className = 'session-duration';
    dur.textContent = formatDuration(group.agg.totalMin);
    item.appendChild(dur);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-delete-entry';
    delBtn.textContent = '×';
    delBtn.title = group.members.length > 1 ? `Delete (×${group.members.length})` : 'Delete';
    armConfirmButton(delBtn, async () => {
      for (const member of group.members) {
        if (member.synced && member.serverEntryId) {
          await requestServerEntryDelete(member.serverEntryId, member);
          continue;
        }
        await browser.runtime.sendMessage({ type: 'DELETE_PENDING_ENTRY', entryId: member.id, entrySnapshot: member });
      }
      requestRefresh();
    });
    item.appendChild(delBtn);

    container.appendChild(item);
  }

  if (groups.length > sessionDisplayCount) {
    const loadMore = document.createElement('button');
    loadMore.className = 'btn-sync-dashboard';
    loadMore.style.width = '100%';
    loadMore.style.marginTop = '12px';
    loadMore.textContent = `Show ${groups.length - sessionDisplayCount} more sessions`;
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
    isPassive: entry.isPassive,
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

function createServerSessionItem(group: ServerSessionGroup): HTMLElement {
  const session = group.first;
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
    ph.textContent = (session.platform && PLATFORM_ICONS[session.platform as Platform]) || session.icon || '⏵';
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
  dateEl.textContent = formatSessionStart(earliestIsoDate(group.members.map(m => m.date)), getDayStartHour());
  meta.appendChild(dateEl);

  if (isAttentionDisplayEnabled() && group.agg.tagged) {
    attachAttentionLabels(meta, item, group.agg, session.activity_type as ActivityType | undefined, (mode, targetIsPassive) => {
      const targets = group.members.filter(m => m.isPassive === (mode === 'passive'));
      return retagSequentially(targets, targetIsPassive, (m, v) => requestRetagServerEntry(m, v)).then(res => {
        if (res?.success) {
          const ids = new Set(targets.map(m => String(m.id)));
          for (const m of targets) m.isPassive = targetIsPassive;
          if (rawServerCache) {
            rawServerCache = rawServerCache.map(s => ids.has(String(s.id)) ? { ...s, isPassive: targetIsPassive } : s);
          }
        }
        return res;
      });
    });
  }

  info.appendChild(meta);

  item.appendChild(info);

  const dur = document.createElement('div');
  dur.className = 'session-duration';
  dur.textContent = formatDuration(group.agg.totalMin);
  item.appendChild(dur);

  const delBtn = document.createElement('button');
  delBtn.className = 'btn-delete-entry';
  delBtn.textContent = '×';
  delBtn.title = group.members.length > 1 ? `Delete (×${group.members.length})` : 'Delete';
  armConfirmButton(delBtn, async () => {
    for (const member of group.members) {
      const idStr = String(member.id ?? '');
      if (!idStr) continue;
      if (!/^\d+$/.test(idStr)) {
        // Local entry shown in the merged list
        await browser.runtime.sendMessage({ type: 'DELETE_PENDING_ENTRY', entryId: idStr });
        continue;
      }
      if (!await requestServerEntryDelete(Number(idStr), serverSessionToPendingEntry(member))) continue;

      if (rawServerCache) {
        rawServerCache = rawServerCache.filter(s => String(s.id) !== idStr);
      }
      const durationSec = member.duration_seconds || 0;
      if (durationSec > 0) {
        const cached = await readCachedServerStats();
        if (cached) {
          const dsh = getDayStartHour();
          const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const tzMatch = !cached.timezone || cached.timezone === browserTz;
          const sessionDate = member.date ? getLocalDateString(new Date(member.date), dsh) : '';
          const today = getLocalDateString(new Date(), dsh);
          const weekDays = getWeekDates(dsh);
          const weekStart = weekDays[0]?.date ?? '';
          const weekEnd = weekDays[weekDays.length - 1]?.date ?? '';
          subtractSessionFromServerStats(cached, durationSec, sessionDate, today, weekStart, weekEnd, browserTz, member.isPassive);
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
    }
    item.remove();
    void renderRecentlyDeleted();
    requestRefresh();
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

  if (isAttentionDisplayEnabled()) container.appendChild(createBulkTagToolbar());

  const groups = groupServerSessions(merged);
  const display = serverSessionsExpanded ? groups : groups.slice(0, INITIAL_SERVER_SESSIONS);
  const remaining = serverSessionsExpanded ? 0 : groups.length - INITIAL_SERVER_SESSIONS;

  for (const group of display) {
    container.appendChild(createServerSessionItem(group));
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
      for (const group of groups.slice(INITIAL_SERVER_SESSIONS)) {
        container.appendChild(createServerSessionItem(group));
      }
    });
    container.appendChild(showMore);
  }
}
