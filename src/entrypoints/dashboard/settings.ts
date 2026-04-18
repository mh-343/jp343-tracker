import type { ExtensionSettings, BlockedChannel, Platform, SpotifyContentType, PendingEntry, ExtensionStats } from '../../types';
import { STORAGE_KEYS, DEFAULT_SETTINGS } from '../../types';

interface ExportData {
  exportVersion: 1;
  exportedAt: string;
  extensionVersion: string;
  data: {
    settings: ExtensionSettings;
    entries: PendingEntry[];
    stats: ExtensionStats;
  };
}

const PLATFORM_LABELS: Record<Platform, string> = {
  youtube: 'YouTube',
  netflix: 'Netflix',
  crunchyroll: 'Crunchyroll',
  primevideo: 'Prime Video',
  disneyplus: 'Disney+',
  cijapanese: 'CI Japanese',
  spotify: 'Spotify',
  generic: 'Generic'
};

const CONTENT_TYPE_LABELS: Record<SpotifyContentType, string> = {
  music: 'Music',
  podcast: 'Podcasts',
  audiobook: 'Audiobooks'
};

async function getSettings(): Promise<ExtensionSettings> {
  const response = await browser.runtime.sendMessage({ type: 'GET_SETTINGS' });
  if (response.success && response.data?.settings) {
    return response.data.settings as ExtensionSettings;
  }
  return { ...DEFAULT_SETTINGS };
}

async function updateSettings(patch: Partial<ExtensionSettings>): Promise<void> {
  const current = await getSettings();
  const updated = { ...current, ...patch };
  await browser.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: updated });
}

function createToggleRow(
  label: string,
  description: string,
  enabled: boolean,
  onChange: (val: boolean) => Promise<void>
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'settings-row';

  const info = document.createElement('div');
  info.className = 'settings-row-info';
  const labelEl = document.createElement('div');
  labelEl.className = 'settings-row-label';
  labelEl.textContent = label;
  info.appendChild(labelEl);
  if (description) {
    const desc = document.createElement('div');
    desc.className = 'settings-row-desc';
    desc.textContent = description;
    info.appendChild(desc);
  }

  const toggle = document.createElement('button');
  toggle.className = 'settings-toggle' + (enabled ? ' enabled' : '');
  toggle.type = 'button';
  toggle.addEventListener('click', async () => {
    const newVal = !toggle.classList.contains('enabled');
    toggle.classList.toggle('enabled', newVal);
    await onChange(newVal);
  });

  row.appendChild(info);
  row.appendChild(toggle);
  return row;
}

function showStatus(container: HTMLElement, message: string, type: 'success' | 'error'): void {
  let el = container.querySelector('.settings-status') as HTMLElement | null;
  if (!el) {
    el = document.createElement('div');
    el.className = 'settings-status';
    container.appendChild(el);
  }
  el.className = 'settings-status ' + type;
  el.textContent = message;
  if (type === 'success') {
    setTimeout(() => { el!.className = 'settings-status'; }, 3000);
  }
}

// ── Panel A: General Settings ────────────────────────────

function buildGeneralPanel(container: HTMLElement, settings: ExtensionSettings): void {
  const section = document.createElement('div');
  section.className = 'settings-section';

  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'General';
  section.appendChild(title);

  section.appendChild(createToggleRow(
    'Tracking enabled',
    'Pause all tracking when disabled',
    settings.enabled,
    async (val) => {
      await browser.runtime.sendMessage({ type: 'SET_ENABLED', enabled: val });
    }
  ));

  section.appendChild(createToggleRow(
    'Merge same-day sessions',
    'Combine repeated sessions of the same video on the same day',
    settings.mergeSameDaySessions,
    async (val) => { await updateSettings({ mergeSameDaySessions: val }); }
  ));

  buildGoalRow(section, settings);
  buildPlatformToggles(section, settings);
  buildSpotifyChips(section, settings);

  container.appendChild(section);
}

function buildGoalRow(container: HTMLElement, settings: ExtensionSettings): void {
  const row = document.createElement('div');
  row.className = 'settings-goal-row';

  const label = document.createElement('div');
  label.className = 'settings-goal-label';
  label.textContent = 'Daily goal';
  row.appendChild(label);

  let useHours = false;
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'settings-goal-input';
  input.min = '1';
  input.max = '1440';
  input.value = String(settings.dailyGoalMinutes);

  const unitBtn = document.createElement('button');
  unitBtn.type = 'button';
  unitBtn.className = 'settings-goal-unit';
  unitBtn.textContent = 'min';
  unitBtn.addEventListener('click', () => {
    useHours = !useHours;
    unitBtn.textContent = useHours ? 'hr' : 'min';
    const current = parseFloat(input.value) || 0;
    input.value = useHours ? String(+(current / 60).toFixed(1)) : String(Math.round(current * 60));
  });

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'settings-goal-save';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', async () => {
    const raw = parseFloat(input.value) || 0;
    const minutes = Math.max(1, useHours ? Math.round(raw * 60) : Math.round(raw));
    await updateSettings({ dailyGoalMinutes: minutes });
    useHours = false;
    unitBtn.textContent = 'min';
    input.value = String(minutes);
    showStatus(container, 'Daily goal updated', 'success');
  });

  row.appendChild(input);
  row.appendChild(unitBtn);
  row.appendChild(saveBtn);
  container.appendChild(row);
}

function buildPlatformToggles(container: HTMLElement, settings: ExtensionSettings): void {
  const platforms = DEFAULT_SETTINGS.enabledPlatforms.filter(p => p !== 'generic');
  for (const platform of platforms) {
    container.appendChild(createToggleRow(
      PLATFORM_LABELS[platform] || platform,
      '',
      settings.enabledPlatforms.includes(platform),
      async (val) => {
        const current = await getSettings();
        const list = val
          ? [...new Set([...current.enabledPlatforms, platform])]
          : current.enabledPlatforms.filter(p => p !== platform);
        await updateSettings({ enabledPlatforms: list as Platform[] });
      }
    ));
  }
}

function buildSpotifyChips(container: HTMLElement, settings: ExtensionSettings): void {
  const row = document.createElement('div');
  row.className = 'settings-row';

  const info = document.createElement('div');
  info.className = 'settings-row-info';
  const label = document.createElement('div');
  label.className = 'settings-row-label';
  label.textContent = 'Spotify content types';
  const desc = document.createElement('div');
  desc.className = 'settings-row-desc';
  desc.textContent = 'Which Spotify content to track';
  info.appendChild(label);
  info.appendChild(desc);
  row.appendChild(info);

  const chips = document.createElement('div');
  chips.className = 'content-type-chips';

  const types: SpotifyContentType[] = ['music', 'podcast', 'audiobook'];
  for (const type of types) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'content-type-chip' + (settings.spotifyContentTypes.includes(type) ? ' active' : '');
    chip.textContent = CONTENT_TYPE_LABELS[type];
    chip.addEventListener('click', async () => {
      const current = await getSettings();
      const list = chip.classList.contains('active')
        ? current.spotifyContentTypes.filter(t => t !== type)
        : [...new Set([...current.spotifyContentTypes, type])];
      if (list.length === 0) return;
      chip.classList.toggle('active');
      await updateSettings({ spotifyContentTypes: list as SpotifyContentType[] });
    });
    chips.appendChild(chip);
  }

  row.appendChild(chips);
  container.appendChild(row);
}

// ── Panel B: Blocked Channels ────────────────────────────

function buildBlockedPanel(container: HTMLElement, settings: ExtensionSettings): void {
  const card = document.createElement('div');
  card.className = 'card';

  const header = document.createElement('div');
  header.className = 'blocked-header';
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = 'Blocked Channels';
  title.style.marginBottom = '0';
  const count = document.createElement('span');
  count.className = 'blocked-count';
  count.id = 'settingsBlockedCount';
  count.textContent = `${settings.blockedChannels.length} blocked`;
  header.appendChild(title);
  header.appendChild(count);
  card.appendChild(header);

  const channels = settings.blockedChannels;

  if (channels.length >= 5) {
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'blocked-search';
    search.placeholder = 'Filter channels...';
    search.addEventListener('input', () => {
      renderBlockedList(list, channels, search.value);
    });
    card.appendChild(search);
  }

  const list = document.createElement('div');
  list.id = 'settingsBlockedList';
  renderBlockedList(list, channels, '');
  card.appendChild(list);

  container.appendChild(card);
}

function renderBlockedList(listEl: HTMLElement, channels: BlockedChannel[], filter: string): void {
  listEl.textContent = '';

  const filtered = filter
    ? channels.filter(c => c.channelName.toLowerCase().includes(filter.toLowerCase()))
    : channels;

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'blocked-empty';
    empty.textContent = channels.length === 0 ? 'No blocked channels' : 'No matches';
    listEl.appendChild(empty);
    return;
  }

  for (const channel of filtered) {
    listEl.appendChild(createBlockedRow(channel, channels));
  }
}

function createBlockedRow(channel: BlockedChannel, allChannels: BlockedChannel[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'blocked-row';

  const name = document.createElement('span');
  name.className = 'blocked-channel-name';
  name.textContent = channel.channelName;
  name.title = channel.channelName;

  const badge = document.createElement('span');
  badge.className = 'blocked-platform-badge';
  badge.textContent = getPlatformFromChannelId(channel.channelId);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'blocked-unblock-btn';
  btn.textContent = 'Unblock';
  btn.addEventListener('click', async () => {
    await browser.runtime.sendMessage({ type: 'UNBLOCK_CHANNEL', channelId: channel.channelId });
    const idx = allChannels.findIndex(c => c.channelId === channel.channelId);
    if (idx !== -1) allChannels.splice(idx, 1);
    row.remove();
    const countEl = document.getElementById('settingsBlockedCount');
    if (countEl) countEl.textContent = `${allChannels.length} blocked`;
  });

  row.appendChild(name);
  row.appendChild(badge);
  row.appendChild(btn);
  return row;
}

function getPlatformFromChannelId(channelId: string): string {
  if (channelId.startsWith('spotify:')) return 'spotify';
  if (channelId.startsWith('netflix:')) return 'netflix';
  if (channelId.startsWith('crunchyroll:')) return 'crunchyroll';
  if (channelId.startsWith('primevideo:')) return 'primevideo';
  if (channelId.startsWith('disneyplus:')) return 'disneyplus';
  return 'youtube';
}


function buildDiagnosticsPanel(container: HTMLElement, settings: ExtensionSettings): void {
  const section = document.createElement('div');
  section.className = 'settings-section';

  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'Help improve jp343';
  section.appendChild(title);

  section.appendChild(createToggleRow(
    'Anonymous statistics',
    'Share anonymous statistics to help detect platform issues early. No watch history, titles, or personal data is sent.',
    settings.diagnosticsEnabled,
    async (val) => { await updateSettings({ diagnosticsEnabled: val }); }
  ));

  container.appendChild(section);
}


function buildExportImportPanel(container: HTMLElement): void {
  const section = document.createElement('div');
  section.className = 'settings-section';

  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'Export / Import';
  section.appendChild(title);

  const desc = document.createElement('div');
  desc.className = 'settings-row-desc';
  desc.textContent = 'Backup your sessions, stats, and settings as a JSON file.';
  desc.style.marginBottom = '16px';
  section.appendChild(desc);

  const actions = document.createElement('div');
  actions.className = 'export-import-actions';

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'export-btn';
  exportBtn.textContent = 'Export JSON';
  exportBtn.addEventListener('click', () => handleExport(section));
  actions.appendChild(exportBtn);

  const importLabel = document.createElement('label');
  importLabel.className = 'import-label';
  importLabel.textContent = 'Import JSON';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json';
  fileInput.className = 'import-file-input';
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) handleImportFile(file, section);
    fileInput.value = '';
  });
  importLabel.appendChild(fileInput);
  actions.appendChild(importLabel);

  section.appendChild(actions);
  container.appendChild(section);
}

async function handleExport(statusContainer: HTMLElement): Promise<void> {
  try {
    const result = await browser.storage.local.get([
      STORAGE_KEYS.PENDING,
      STORAGE_KEYS.STATS,
      STORAGE_KEYS.SETTINGS
    ]);

    const data: ExportData = {
      exportVersion: 1,
      exportedAt: new Date().toISOString(),
      extensionVersion: browser.runtime.getManifest().version,
      data: {
        settings: result[STORAGE_KEYS.SETTINGS] || { ...DEFAULT_SETTINGS },
        entries: result[STORAGE_KEYS.PENDING] || [],
        stats: result[STORAGE_KEYS.STATS] || { totalMinutes: 0, dailyMinutes: {}, lastActiveDate: '', currentStreak: 0 }
      }
    };

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jp343-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus(statusContainer, 'Export downloaded', 'success');
  } catch (error) {
    showStatus(statusContainer, 'Export failed: ' + (error instanceof Error ? error.message : 'Unknown error'), 'error');
  }
}

async function handleImportFile(file: File, statusContainer: HTMLElement): Promise<void> {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text) as ExportData;

    if (parsed.exportVersion !== 1 || !parsed.data) {
      showStatus(statusContainer, 'Invalid backup file format', 'error');
      return;
    }
    if (!Array.isArray(parsed.data.entries) || typeof parsed.data.stats?.dailyMinutes !== 'object') {
      showStatus(statusContainer, 'Backup file has invalid data structure', 'error');
      return;
    }

    showImportPreview(statusContainer, parsed);
  } catch {
    showStatus(statusContainer, 'Failed to read backup file', 'error');
  }
}

function showImportPreview(container: HTMLElement, data: ExportData): void {
  const existing = container.querySelector('.import-preview');
  if (existing) existing.remove();

  const preview = document.createElement('div');
  preview.className = 'import-preview';

  const title = document.createElement('div');
  title.className = 'import-preview-title';
  title.textContent = 'Backup Preview';
  preview.appendChild(title);

  const stats = document.createElement('div');
  stats.className = 'import-preview-stats';
  const entryCount = data.data.entries.length;
  const dayCount = Object.keys(data.data.stats.dailyMinutes || {}).length;
  const version = data.extensionVersion || 'unknown';
  const date = data.exportedAt ? new Date(data.exportedAt).toLocaleDateString() : 'unknown';
  stats.textContent = `${entryCount} sessions, ${dayCount} days of stats. Exported from v${version} on ${date}.`;
  preview.appendChild(stats);

  const actions = document.createElement('div');
  actions.className = 'import-preview-actions';

  const btnEntriesOnly = document.createElement('button');
  btnEntriesOnly.type = 'button';
  btnEntriesOnly.className = 'import-btn';
  btnEntriesOnly.textContent = 'Import entries only';
  btnEntriesOnly.addEventListener('click', () => {
    executeImport(data, false, container);
  });

  const btnAll = document.createElement('button');
  btnAll.type = 'button';
  btnAll.className = 'import-btn-secondary';
  btnAll.textContent = 'Import entries + settings';
  btnAll.addEventListener('click', () => {
    executeImport(data, true, container);
  });

  const btnCancel = document.createElement('button');
  btnCancel.type = 'button';
  btnCancel.className = 'import-btn-secondary';
  btnCancel.textContent = 'Cancel';
  btnCancel.addEventListener('click', () => { preview.remove(); });

  actions.appendChild(btnEntriesOnly);
  actions.appendChild(btnAll);
  actions.appendChild(btnCancel);
  preview.appendChild(actions);
  container.appendChild(preview);
}

async function executeImport(data: ExportData, includeSettings: boolean, statusContainer: HTMLElement): Promise<void> {
  try {
    const local = await browser.storage.local.get([
      STORAGE_KEYS.PENDING,
      STORAGE_KEYS.STATS,
      STORAGE_KEYS.SETTINGS
    ]);

    const localEntries: PendingEntry[] = local[STORAGE_KEYS.PENDING] || [];
    const localStats: ExtensionStats = local[STORAGE_KEYS.STATS] || { totalMinutes: 0, dailyMinutes: {}, lastActiveDate: '', currentStreak: 0 };

    const mergedEntries = mergeEntries(localEntries, data.data.entries);
    const mergedStats = mergeStats(localStats, data.data.stats);

    const updates: Record<string, unknown> = {
      [STORAGE_KEYS.PENDING]: mergedEntries,
      [STORAGE_KEYS.STATS]: mergedStats
    };

    if (includeSettings && data.data.settings) {
      updates[STORAGE_KEYS.SETTINGS] = { ...DEFAULT_SETTINGS, ...data.data.settings };
    }

    await browser.storage.local.set(updates);
    document.dispatchEvent(new CustomEvent('jp343:refresh'));

    const preview = statusContainer.querySelector('.import-preview');
    if (preview) preview.remove();

    const added = mergedEntries.length - localEntries.length;
    showStatus(statusContainer, `Imported ${added} new entries` + (includeSettings ? ' and settings' : ''), 'success');
  } catch (error) {
    showStatus(statusContainer, 'Import failed: ' + (error instanceof Error ? error.message : 'Unknown error'), 'error');
  }
}

function mergeEntries(local: PendingEntry[], imported: PendingEntry[]): PendingEntry[] {
  const localIds = new Set(local.map(e => e.id));
  const newEntries = imported.filter(e => !localIds.has(e.id));
  return [...local, ...newEntries];
}

function mergeStats(local: ExtensionStats, imported: ExtensionStats): ExtensionStats {
  const mergedDaily: Record<string, number> = { ...local.dailyMinutes };
  for (const [date, minutes] of Object.entries(imported.dailyMinutes || {})) {
    mergedDaily[date] = Math.max(mergedDaily[date] || 0, minutes);
  }

  const totalMinutes = Object.values(mergedDaily).reduce((sum, m) => sum + m, 0);
  const lastActiveDate = local.lastActiveDate > (imported.lastActiveDate || '')
    ? local.lastActiveDate
    : (imported.lastActiveDate || local.lastActiveDate);
  const currentStreak = local.lastActiveDate >= (imported.lastActiveDate || '')
    ? local.currentStreak
    : (imported.currentStreak || local.currentStreak);

  return { totalMinutes, dailyMinutes: mergedDaily, lastActiveDate, currentStreak };
}

// ── Setup ────────────────────────────────────────────────

async function rebuildSettingsPanel(panel: HTMLElement): Promise<void> {
  panel.textContent = '';
  const settings = await getSettings();
  buildGeneralPanel(panel, settings);
  buildDiagnosticsPanel(panel, settings);
  buildExportImportPanel(panel);
}

async function rebuildBlockedPanel(panel: HTMLElement): Promise<void> {
  panel.textContent = '';
  const settings = await getSettings();
  buildBlockedPanel(panel, settings);
}

export async function setupSettings(): Promise<void> {
  const settingsPanel = document.getElementById('tabSettings');
  const blockedPanel = document.getElementById('tabBlocked');
  if (!settingsPanel || !blockedPanel) return;

  await rebuildSettingsPanel(settingsPanel);
  await rebuildBlockedPanel(blockedPanel);
}
