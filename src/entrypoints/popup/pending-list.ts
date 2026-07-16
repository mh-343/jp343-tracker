import type { PendingEntry, Platform } from '../../types';
import { formatDuration, formatSessionDate, isValidImageUrl } from '../../lib/format-utils';

export interface PendingListDeps {
  listEl: HTMLElement;
  platformIcons: Record<Platform, string>;
  getDayStartHour: () => number;
  onEntriesChanged: (entries: PendingEntry[]) => void;
}

interface GroupedEntry {
  primary: PendingEntry;
  entries: PendingEntry[];
  entryIds: string[];
  totalMinutes: number;
  sessionCount: number;
  hasError: boolean;
}

interface RenameResponse {
  success?: boolean;
  data?: { title?: string; pendingServerSync?: boolean };
  error?: string;
}

function groupEntriesByVideo(entries: PendingEntry[]): GroupedEntry[] {
  const groups = new Map<string, GroupedEntry>();

  for (const entry of entries) {
    const key = entry.project_id || entry.url;

    if (groups.has(key)) {
      const group = groups.get(key)!;
      group.entries.push(entry);
      group.entryIds.push(entry.id);
      group.totalMinutes += entry.duration_min;
      group.sessionCount++;
      if (entry.lastSyncError) group.hasError = true;
      if (new Date(entry.date) > new Date(group.primary.date)) {
        group.primary = entry;
      }
    } else {
      groups.set(key, {
        primary: entry,
        entries: [entry],
        entryIds: [entry.id],
        totalMinutes: entry.duration_min,
        sessionCount: 1,
        hasError: !!entry.lastSyncError
      });
    }
  }

  const result = Array.from(groups.values());
  for (const group of result) {
    group.entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    group.entryIds = group.entries.map(e => e.id);
  }
  return result;
}

function isRenamableSeries(projectId: string): boolean {
  return projectId.startsWith('ext_generic_cs_');
}

function createPencilIcon(): SVGSVGElement {
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('width', '11');
  svg.setAttribute('height', '11');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  const path = document.createElementNS(svgNs, 'path');
  path.setAttribute('d', 'M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z');
  svg.appendChild(path);
  return svg;
}

function attachGroupRename(titleRow: HTMLElement, titleSpan: HTMLElement, entry: PendingEntry): void {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pending-entry-rename';
  btn.title = 'Rename series';
  btn.appendChild(createPencilIcon());
  titleRow.appendChild(btn);

  const status = document.createElement('span');
  status.className = 'pending-rename-status';
  titleRow.appendChild(status);

  let editing = false;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (editing) return;
    editing = true;
    const previousTitle = entry.project;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'session-title-input';
    input.value = previousTitle;
    titleSpan.style.display = 'none';
    btn.style.display = 'none';
    status.textContent = '';
    titleRow.insertBefore(input, titleSpan);
    input.focus();
    input.select();

    let saving = false;
    const finish = (): void => {
      input.remove();
      titleSpan.style.display = '';
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
          projectId: entry.project_id,
          title: newTitle,
          previousTitle
        }) as RenameResponse;
        if (res?.success) {
          const finalTitle = res.data?.title ?? newTitle;
          entry.project = finalTitle;
          titleSpan.textContent = finalTitle;
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
  });
}

function renderEntryGroup(group: GroupedEntry, deps: PendingListDeps): HTMLElement {
  const entry = group.primary;
  const groupKey = entry.project_id || entry.url;
  const ids = group.entryIds.join(',');
  const hasMultiple = group.sessionCount > 1;

  const container = document.createElement('div');
  container.className = 'pending-entry-group';
  container.dataset.groupKey = groupKey;

  const entryDiv = document.createElement('div');
  entryDiv.className = 'pending-entry';
  entryDiv.dataset.ids = ids;
  entryDiv.dataset.url = entry.url || '';

  const thumbWrap = document.createElement('div');
  thumbWrap.className = `pending-entry-thumb-wrap${entry.url ? ' clickable' : ''}`;
  thumbWrap.dataset.url = entry.url || '';
  if (entry.url) thumbWrap.title = 'Open video';

  if (entry.thumbnail && isValidImageUrl(entry.thumbnail)) {
    const img = document.createElement('img');
    img.src = entry.thumbnail;
    img.className = 'pending-entry-thumb';
    img.alt = '';
    thumbWrap.appendChild(img);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'pending-entry-thumb';
    Object.assign(placeholder.style, { display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px' });
    placeholder.textContent = deps.platformIcons[entry.platform] || '⏵';
    thumbWrap.appendChild(placeholder);
  }
  if (entry.url) {
    const playIcon = document.createElement('span');
    playIcon.className = 'pending-entry-play';
    playIcon.textContent = '▶';
    thumbWrap.appendChild(playIcon);
  }

  const info = document.createElement('div');
  info.className = 'pending-entry-info';

  const titleRow = document.createElement('div');
  titleRow.className = 'pending-entry-title-row';
  const titleSpan = document.createElement('span');
  titleSpan.className = `pending-entry-title${entry.url ? ' clickable' : ''}`;
  titleSpan.dataset.ids = ids;
  titleSpan.dataset.url = entry.url || '';
  titleSpan.textContent = entry.project;
  titleRow.appendChild(titleSpan);
  if (isRenamableSeries(entry.project_id)) {
    attachGroupRename(titleRow, titleSpan, entry);
  }

  const meta = document.createElement('div');
  meta.className = 'pending-entry-meta';
  const platformLabel = entry.platform === 'generic' && entry.activityType ? entry.activityType : entry.platform;
  meta.append(`${platformLabel} · `);
  const strong = document.createElement('strong');
  strong.textContent = formatDuration(group.totalMinutes);
  meta.appendChild(strong);

  if (hasMultiple) {
    const expandBtn = document.createElement('button');
    expandBtn.className = 'pending-entry-expand';
    expandBtn.dataset.groupKey = groupKey;
    expandBtn.title = `Show ${group.sessionCount} sessions`;
    expandBtn.textContent = `(${group.sessionCount}×) ▼`;
    meta.appendChild(expandBtn);
  }
  if (entry.url) {
    const continueBtn = document.createElement('button');
    continueBtn.className = 'pending-entry-continue';
    continueBtn.dataset.url = entry.url;
    continueBtn.title = 'Continue watching';
    continueBtn.textContent = 'Continue ▶';
    meta.appendChild(continueBtn);
  }

  info.append(titleRow, meta);
  entryDiv.append(thumbWrap, info);
  container.appendChild(entryDiv);

  if (hasMultiple) {
    const detailsList = document.createElement('div');
    detailsList.className = 'session-details-list';
    detailsList.dataset.groupKey = groupKey;
    detailsList.style.display = 'none';

    for (const e of group.entries) {
      const detail = document.createElement('div');
      detail.className = 'session-detail';
      detail.dataset.id = e.id;

      const dateSpan = document.createElement('span');
      dateSpan.className = 'session-detail-date';
      dateSpan.textContent = formatSessionDate(e.date, deps.getDayStartHour());
      detail.appendChild(dateSpan);

      const durSpan = document.createElement('span');
      durSpan.className = 'session-detail-duration';
      durSpan.textContent = formatDuration(e.duration_min);
      detail.appendChild(durSpan);
      detailsList.appendChild(detail);
    }
    container.appendChild(detailsList);
  }

  return container;
}

export function renderPendingList(entries: PendingEntry[], deps: PendingListDeps): void {
  deps.onEntriesChanged(entries);

  if (entries.length === 0) {
    deps.listEl.textContent = '';
    return;
  }

  const expandedGroups = new Set<string>();
  deps.listEl.querySelectorAll('.session-details-list').forEach(el => {
    if ((el as HTMLElement).style.display !== 'none') {
      expandedGroups.add((el as HTMLElement).dataset.groupKey || '');
    }
  });

  const grouped = groupEntriesByVideo(entries);
  const sorted = [...grouped]
    .sort((a, b) => new Date(b.primary.date).getTime() - new Date(a.primary.date).getTime())
    .slice(0, 8);

  deps.listEl.textContent = '';
  for (const g of sorted) {
    deps.listEl.appendChild(renderEntryGroup(g, deps));
  }

  deps.listEl.querySelectorAll('.pending-entry-thumb-wrap.clickable').forEach(thumb => {
    thumb.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = (thumb as HTMLElement).dataset.url;
      if (url && /^https?:\/\//i.test(url)) {
        browser.tabs.create({ url });
      }
    });
  });

  deps.listEl.querySelectorAll('.pending-entry-title.clickable').forEach(title => {
    title.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = (title as HTMLElement).dataset.url;
      if (url && /^https?:\/\//i.test(url)) {
        browser.tabs.create({ url });
      }
    });
  });

  deps.listEl.querySelectorAll('.pending-entry-continue').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const url = (btn as HTMLElement).dataset.url;
      if (url && /^https?:\/\//i.test(url)) {
        await browser.tabs.create({ url });
        window.close();
      }
    });
  });

  deps.listEl.querySelectorAll('.pending-entry-expand').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const groupKey = (btn as HTMLElement).dataset.groupKey;
      const detailsList = deps.listEl.querySelector(`.session-details-list[data-group-key="${groupKey}"]`) as HTMLElement;
      if (detailsList) {
        const isExpanded = detailsList.style.display !== 'none';
        detailsList.style.display = isExpanded ? 'none' : 'block';
        btn.textContent = btn.textContent?.replace(isExpanded ? '▲' : '▼', isExpanded ? '▼' : '▲') || '';
      }
    });
  });

  expandedGroups.forEach(groupKey => {
    const detailsList = deps.listEl.querySelector(`.session-details-list[data-group-key="${groupKey}"]`) as HTMLElement;
    const expandBtn = deps.listEl.querySelector(`.pending-entry-expand[data-group-key="${groupKey}"]`) as HTMLElement;
    if (detailsList) {
      detailsList.style.display = 'block';
      if (expandBtn) {
        expandBtn.textContent = expandBtn.textContent?.replace('▼', '▲') || '';
      }
    }
  });
}
