import type { CustomSitesState, CustomSite } from '../../types';
import { normalizeHost, customSiteOrigin } from '../../lib/background/custom-sites';

async function loadSites(): Promise<CustomSite[]> {
  const res = await browser.runtime.sendMessage({ type: 'CUSTOM_SITES_GET' });
  const data = res?.success ? res.data as { customSites: CustomSitesState } : null;
  return data?.customSites.sites ?? [];
}

async function siteIsActive(host: string): Promise<boolean> {
  try {
    return await browser.permissions.contains({ origins: [customSiteOrigin(host)] });
  } catch {
    return false;
  }
}

function renderRow(site: CustomSite, active: boolean, listEl: HTMLElement, statusEl: HTMLElement): HTMLElement {
  const row = document.createElement('div');
  row.className = 'custom-site-row';

  const name = document.createElement('span');
  name.className = 'custom-site-host';
  name.textContent = site.host;

  const state = document.createElement('span');
  state.className = active ? 'custom-site-state' : 'custom-site-state missing';
  state.textContent = active ? 'Allowed' : 'Permission missing';

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'custom-site-remove';
  remove.textContent = 'Remove';
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    await browser.runtime.sendMessage({ type: 'CUSTOM_SITE_REMOVE', id: site.id });
    row.remove();
    if (!listEl.querySelector('.custom-site-row')) statusEl.textContent = 'No sites added yet.';
  });

  row.appendChild(name);
  row.appendChild(state);
  row.appendChild(remove);
  return row;
}

async function refreshList(listEl: HTMLElement, statusEl: HTMLElement): Promise<void> {
  listEl.textContent = '';
  const sites = await loadSites();
  if (sites.length === 0) {
    statusEl.textContent = 'No sites added yet.';
    return;
  }
  statusEl.textContent = '';
  for (const site of sites) {
    const active = await siteIsActive(site.host);
    listEl.appendChild(renderRow(site, active, listEl, statusEl));
  }
}

export function buildCustomSitesPanel(container: HTMLElement): void {
  const section = document.createElement('div');
  section.className = 'settings-section';

  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'Custom Sites ';
  const beta = document.createElement('span');
  beta.className = 'custom-site-beta';
  beta.textContent = 'Beta';
  title.appendChild(beta);
  section.appendChild(title);

  const help = document.createElement('div');
  help.className = 'settings-row-desc';
  help.textContent = 'Add a website and jp343 tracks how long its videos play. It works on many video sites, but not all: some use players it cannot read. Your browser asks permission per site, and only video play time is counted.';
  section.appendChild(help);

  const addRow = document.createElement('div');
  addRow.className = 'custom-site-add';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'custom-site-input';
  input.placeholder = 'example.com';
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'export-btn';
  addBtn.textContent = 'Add site';
  addRow.appendChild(input);
  addRow.appendChild(addBtn);
  section.appendChild(addRow);

  const status = document.createElement('div');
  status.className = 'settings-row-desc';

  const list = document.createElement('div');
  list.className = 'custom-site-list';

  const onAdd = async (): Promise<void> => {
    const norm = normalizeHost(input.value);
    if (!norm.ok || !norm.host) {
      status.textContent = norm.error || 'That is not a valid address';
      return;
    }
    const origin = customSiteOrigin(norm.host);
    let granted = false;
    try {
      granted = await browser.permissions.request({ origins: [origin] });
    } catch {
      granted = false;
    }
    if (!granted) {
      status.textContent = 'Access was not granted, so this site is not tracked.';
      return;
    }
    const res = await browser.runtime.sendMessage({ type: 'CUSTOM_SITE_ADD', host: norm.host });
    if (!res?.success) {
      status.textContent = res?.error || 'Could not add this site.';
      try { await browser.permissions.remove({ origins: [origin] }); } catch { /* skipped */ }
      return;
    }
    input.value = '';
    await refreshList(list, status);
  };

  addBtn.addEventListener('click', () => { void onAdd(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); void onAdd(); }
  });

  section.appendChild(status);
  section.appendChild(list);
  container.appendChild(section);
  void refreshList(list, status);
}
