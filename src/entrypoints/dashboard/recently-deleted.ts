import type { DeletedEntrySnapshot } from '../../types';
import { formatDuration, formatSessionDate } from '../../lib/format-utils';
import { armDeleteButton } from './delete-confirm';
import { getDayStartHour } from './stats';

interface DeletedEntriesResponse {
  success?: boolean;
  data?: { entries?: DeletedEntrySnapshot[] };
}

let expanded = false;

function requestRefresh(): void {
  document.dispatchEvent(new CustomEvent('jp343:refresh'));
}

function createDeletedRow(snap: DeletedEntrySnapshot): HTMLElement {
  const row = document.createElement('div');
  row.className = 'deleted-item';

  const info = document.createElement('div');
  info.className = 'deleted-item-info';

  const title = document.createElement('div');
  title.className = 'deleted-item-title';
  title.textContent = snap.entry.project;
  info.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'deleted-item-meta';
  meta.textContent = `${formatDuration(snap.entry.duration_min)} · ${formatSessionDate(snap.entry.date, getDayStartHour())}`;
  info.appendChild(meta);

  row.appendChild(info);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'deleted-restore-btn';
  btn.textContent = 'Restore';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Restoring…';
    let ok = false;
    try {
      const res = await browser.runtime.sendMessage({
        type: 'RESTORE_DELETED_ENTRY',
        entryId: snap.entry.id
      }) as { success?: boolean };
      ok = !!res?.success;
    } catch { /* background unavailable */ }
    if (ok) {
      requestRefresh();
      return;
    }
    btn.textContent = 'Failed';
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = 'Restore';
    }, 1500);
  });
  row.appendChild(btn);

  const purgeBtn = document.createElement('button');
  purgeBtn.type = 'button';
  purgeBtn.className = 'deleted-purge-btn';
  purgeBtn.textContent = 'Delete';
  purgeBtn.title = 'Delete permanently';
  armDeleteButton(purgeBtn, async () => {
    purgeBtn.disabled = true;
    purgeBtn.textContent = 'Deleting…';
    let ok = false;
    try {
      const res = await browser.runtime.sendMessage({
        type: 'PURGE_DELETED_ENTRY',
        entryId: snap.entry.id
      }) as { success?: boolean };
      ok = !!res?.success;
    } catch { /* background unavailable */ }
    if (ok) {
      requestRefresh();
      return;
    }
    purgeBtn.textContent = 'Failed';
    setTimeout(() => {
      purgeBtn.disabled = false;
      purgeBtn.textContent = 'Delete';
    }, 1500);
  }, { idleLabel: 'Delete', idleTitle: 'Delete permanently' });
  row.appendChild(purgeBtn);

  return row;
}

export async function renderRecentlyDeleted(): Promise<void> {
  const container = document.getElementById('recentlyDeleted');
  if (!container) return;

  let snapshots: DeletedEntrySnapshot[] = [];
  try {
    const res = await browser.runtime.sendMessage({ type: 'GET_DELETED_ENTRIES' }) as DeletedEntriesResponse;
    if (res?.success && res.data?.entries) snapshots = res.data.entries;
  } catch { /* background unavailable */ }

  container.textContent = '';
  if (snapshots.length === 0) {
    container.style.display = 'none';
    expanded = false;
    return;
  }
  container.style.display = '';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'deleted-toggle';
  const arrow = document.createElement('span');
  arrow.className = 'deleted-toggle-arrow';
  arrow.textContent = expanded ? '▾' : '▸';
  toggle.appendChild(arrow);
  const label = document.createElement('span');
  label.textContent = `Recently deleted (${snapshots.length})`;
  toggle.appendChild(label);
  container.appendChild(toggle);

  const list = document.createElement('div');
  list.className = 'deleted-list';
  list.style.display = expanded ? '' : 'none';
  container.appendChild(list);

  toggle.addEventListener('click', () => {
    expanded = !expanded;
    arrow.textContent = expanded ? '▾' : '▸';
    list.style.display = expanded ? '' : 'none';
  });

  for (const snap of snapshots) {
    list.appendChild(createDeletedRow(snap));
  }
}
