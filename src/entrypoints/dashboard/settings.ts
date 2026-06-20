import type { ExtensionSettings, BlockedChannel, Platform, SpotifyContentType, PendingEntry, ExtensionStats, ColorTheme, JP343UserState, AnkiState, AnkiCollectionState } from '../../types';
import { STORAGE_KEYS, DEFAULT_SETTINGS, COLOR_THEMES, ANKI_SCHEMA_VERSION } from '../../types';
import { getLocalDateString } from '../../lib/format-utils';
import { resizeImage, saveBackground, loadBackground, removeBackground, applyDashboardBackground, clearBackgroundDom } from '../../lib/background-image';
import { applyColorTheme } from '../../lib/theme';
import { invalidateSessionCache } from './sessions';
import { buildTargetStartSection } from './target-start-settings';

interface ExportData {
  exportVersion: 1;
  exportedAt: string;
  extensionVersion: string;
  data: {
    settings: ExtensionSettings;
    entries: PendingEntry[];
    stats: ExtensionStats;
    anki?: AnkiState;
  };
}

const PLATFORM_LABELS: Record<Platform, string> = {
  youtube: 'YouTube',
  netflix: 'Netflix',
  crunchyroll: 'Crunchyroll',
  primevideo: 'Prime Video',
  disneyplus: 'Disney+',
  cijapanese: 'CI Japanese',
  nihongojikan: 'Nihongo no Jikan',
  spotify: 'Spotify',
  twitch: 'Twitch',
  asbplayer: 'asbplayer',
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

async function getFreshSettings(): Promise<ExtensionSettings> {
  const res = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(res[STORAGE_KEYS.SETTINGS] || {}) };
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

function buildAppearancePanel(container: HTMLElement, settings: ExtensionSettings): void {
  const section = document.createElement('div');
  section.className = 'settings-section';

  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'Appearance';
  section.appendChild(title);

  const themeLabel = document.createElement('div');
  themeLabel.className = 'settings-row-label';
  themeLabel.textContent = 'Color Theme';
  section.appendChild(themeLabel);

  const themeSelector = document.createElement('div');
  themeSelector.className = 'theme-selector';
  for (const [id, theme] of Object.entries(COLOR_THEMES)) {
    const btn = document.createElement('button');
    btn.className = 'theme-btn' + (settings.colorTheme === id ? ' active' : '');
    btn.dataset.theme = id;

    const swatch = document.createElement('span');
    swatch.className = 'theme-swatch';
    swatch.style.background = theme.swatch;
    btn.appendChild(swatch);
    btn.appendChild(document.createTextNode(theme.label));

    btn.addEventListener('click', () => {
      for (const b of themeSelector.querySelectorAll('.theme-btn')) b.classList.remove('active');
      btn.classList.add('active');
      applyColorTheme(id as ColorTheme);
      updateSettings({ colorTheme: id as ColorTheme });
    });
    themeSelector.appendChild(btn);
  }
  section.appendChild(themeSelector);

  const bgLabel = document.createElement('div');
  bgLabel.className = 'settings-row-label';
  bgLabel.textContent = 'Background Image';
  section.appendChild(bgLabel);

  const uploadRow = document.createElement('div');
  uploadRow.className = 'bg-upload-row';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.style.display = 'none';

  const uploadBtn = document.createElement('button');
  uploadBtn.className = 'export-btn';
  uploadBtn.textContent = 'Choose Image';
  uploadBtn.addEventListener('click', () => fileInput.click());

  const removeBtn = document.createElement('button');
  removeBtn.className = 'import-label';
  removeBtn.textContent = 'Remove';
  removeBtn.style.display = settings.backgroundEnabled ? '' : 'none';

  const preview = document.createElement('div');
  preview.className = 'bg-no-preview';
  preview.textContent = 'No image';

  async function showPreview(): Promise<void> {
    const blob = await loadBackground();
    if (blob) {
      const img = document.createElement('img');
      img.className = 'bg-preview';
      img.src = URL.createObjectURL(blob);
      img.alt = '';
      preview.replaceWith(img);
      removeBtn.style.display = '';
    }
  }

  showPreview();

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    uploadBtn.textContent = '...';
    const resized = await resizeImage(file);
    await saveBackground(resized);
    await updateSettings({ backgroundEnabled: true });
    const fresh = await getFreshSettings();
    await applyDashboardBackground(true, fresh.backgroundOpacity ?? 75);
    uploadBtn.textContent = 'Choose Image';
    removeBtn.style.display = '';

    const existing = section.querySelector('.bg-preview, .bg-no-preview');
    if (existing) {
      const img = document.createElement('img');
      img.className = 'bg-preview';
      img.src = URL.createObjectURL(resized);
      img.alt = '';
      existing.replaceWith(img);
    }
    fileInput.value = '';
  });

  removeBtn.addEventListener('click', async () => {
    clearBackgroundDom();
    removeBtn.style.display = 'none';

    const existing = section.querySelector('.bg-preview');
    if (existing) {
      const ph = document.createElement('div');
      ph.className = 'bg-no-preview';
      ph.textContent = 'No image';
      existing.replaceWith(ph);
    }

    await removeBackground();
    await updateSettings({ backgroundEnabled: false });
  });

  uploadRow.appendChild(fileInput);
  uploadRow.appendChild(uploadBtn);
  uploadRow.appendChild(removeBtn);
  uploadRow.appendChild(preview);
  section.appendChild(uploadRow);

  const sliderRow = document.createElement('div');
  sliderRow.className = 'settings-slider-row';

  const sliderLabel = document.createElement('div');
  sliderLabel.className = 'settings-row-label';
  sliderLabel.textContent = 'Background Dimming';
  sliderLabel.style.flex = '0 0 auto';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'settings-slider';
  slider.min = '10';
  slider.max = '95';
  slider.step = '5';
  slider.value = String(settings.backgroundOpacity ?? 75);

  const valueLabel = document.createElement('span');
  valueLabel.className = 'settings-slider-value';
  valueLabel.textContent = `${settings.backgroundOpacity ?? 75}%`;

  slider.addEventListener('input', () => {
    valueLabel.textContent = `${slider.value}%`;
  });

  slider.addEventListener('change', async () => {
    const opacity = Number(slider.value);
    await updateSettings({ backgroundOpacity: opacity });
    const fresh = await getFreshSettings();
    if (fresh.backgroundEnabled) {
      await applyDashboardBackground(true, opacity);
    }
  });

  sliderRow.appendChild(sliderLabel);
  sliderRow.appendChild(slider);
  sliderRow.appendChild(valueLabel);
  section.appendChild(sliderRow);

  section.appendChild(createToggleRow(
    'Stretch Goals',
    'Show level tiers beyond daily goal (or classic overflow bar)',
    settings.stretchGoalsEnabled,
    async (val) => { await updateSettings({ stretchGoalsEnabled: val }); }
  ));

  container.appendChild(section);
}

function buildTrackingPanel(container: HTMLElement, settings: ExtensionSettings): void {
  const section = document.createElement('div');
  section.className = 'settings-section';

  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'Tracking';
  section.appendChild(title);

  section.appendChild(createToggleRow(
    'Tracking enabled',
    'Pause all tracking when disabled',
    settings.enabled,
    async (val) => {
      await browser.runtime.sendMessage({ type: 'SET_ENABLED', enabled: val });
    }
  ));

  buildGoalRow(section, settings);
  buildDayStartRow(section, settings);

  section.appendChild(createToggleRow(
    'Merge same-day sessions',
    'Combine repeated sessions of the same video on the same day',
    settings.mergeSameDaySessions,
    async (val) => { await updateSettings({ mergeSameDaySessions: val }); }
  ));

  section.appendChild(createToggleRow(
    'Track Japanese only',
    'Only track YouTube videos and Twitch streams identified as Japanese',
    settings.trackJapaneseOnly ?? false,
    async (val) => { await updateSettings({ trackJapaneseOnly: val }); }
  ));

  section.appendChild(createToggleRow(
    'Use original YouTube titles',
    'Show untranslated titles instead of auto-translated ones',
    settings.useOriginalTitles ?? false,
    async (val) => { await updateSettings({ useOriginalTitles: val }); }
  ));

  section.appendChild(createToggleRow(
    'Streak-at-risk reminder',
    'Browser notification when your streak is about to break, log today to keep it',
    settings.streakRiskNotification ?? false,
    async (val) => { await updateSettings({ streakRiskNotification: val }); }
  ));

  container.appendChild(section);
}

function buildPlatformsPanel(container: HTMLElement, settings: ExtensionSettings): void {
  const section = document.createElement('div');
  section.className = 'settings-section';

  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'Platforms';
  section.appendChild(title);

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

function buildDayStartRow(container: HTMLElement, settings: ExtensionSettings): void {
  const row = document.createElement('div');
  row.className = 'settings-goal-row';

  const label = document.createElement('div');
  label.className = 'settings-goal-label';
  label.textContent = 'Day starts at';
  row.appendChild(label);

  const select = document.createElement('select');
  select.className = 'settings-goal-input';
  select.style.width = '120px';
  for (let h = 0; h <= 6; h++) {
    const opt = document.createElement('option');
    opt.value = String(h);
    opt.textContent = h === 0 ? '00:00 (default)' : `${String(h).padStart(2, '0')}:00`;
    if (h === (settings.dayStartHour || 0)) opt.selected = true;
    select.appendChild(opt);
  }
  row.appendChild(select);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'settings-goal-save';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', async () => {
    const hour = Math.max(0, Math.min(6, parseInt(select.value, 10) || 0));
    await updateSettings({ dayStartHour: hour });
    showStatus(container, 'Day start updated', 'success');
  });
  row.appendChild(saveBtn);

  const desc = document.createElement('div');
  desc.className = 'settings-description';
  desc.textContent = 'For late-night sessions. Anything before this hour counts toward the previous day.';
  desc.style.cssText = 'font-size:11px;color:var(--text-muted);margin-top:4px;padding:0 4px;';

  container.appendChild(row);
  container.appendChild(desc);
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
  title.textContent = 'Privacy';
  section.appendChild(title);

  section.appendChild(createToggleRow(
    'Anonymous statistics',
    'Share anonymous statistics and error reports to help detect platform issues early. No watch history, titles, or personal data is sent.',
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
  title.textContent = 'Backup';
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
  exportBtn.textContent = 'Download Backup';
  exportBtn.addEventListener('click', () => handleExport(section));
  actions.appendChild(exportBtn);

  const importLabel = document.createElement('label');
  importLabel.className = 'import-label';
  importLabel.textContent = 'Restore Backup';
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
      STORAGE_KEYS.SETTINGS,
      STORAGE_KEYS.ANKI
    ]);

    const data: ExportData = {
      exportVersion: 1,
      exportedAt: new Date().toISOString(),
      extensionVersion: browser.runtime.getManifest().version,
      data: {
        settings: result[STORAGE_KEYS.SETTINGS] || { ...DEFAULT_SETTINGS },
        entries: result[STORAGE_KEYS.PENDING] || [],
        stats: result[STORAGE_KEYS.STATS] || { totalMinutes: 0, dailyMinutes: {}, lastActiveDate: '', currentStreak: 0 },
        anki: result[STORAGE_KEYS.ANKI] as AnkiState | undefined
      }
    };

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jp343-backup-${getLocalDateString()}.json`;
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
  title.textContent = 'Import Preview';
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
  btnEntriesOnly.textContent = 'Import sessions only';
  btnEntriesOnly.addEventListener('click', () => {
    executeImport(data, false, container);
  });

  const btnAll = document.createElement('button');
  btnAll.type = 'button';
  btnAll.className = 'import-btn-secondary';
  btnAll.textContent = 'Import sessions + settings';
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

// strip dirtyDays so an import can't push
function sanitizeImportedAnki(raw: unknown): AnkiState | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Partial<AnkiState>;
  if (!a.collections || typeof a.collections !== 'object') return null;
  const collections: Record<string, AnkiCollectionState> = {};
  for (const [key, c] of Object.entries(a.collections)) {
    const col = (c || {}) as Partial<AnkiCollectionState>;
    collections[key] = {
      lastSyncId: typeof col.lastSyncId === 'number' ? col.lastSyncId : 0,
      backfillDone: !!col.backfillDone,
      days: col.days && typeof col.days === 'object' ? col.days : {},
      seenCardIds: Array.isArray(col.seenCardIds) ? col.seenCardIds : [],
      dirtyDays: [],
      lastPushedAt: typeof col.lastPushedAt === 'number' ? col.lastPushedAt : null,
      lastPushError: null
    };
  }
  return {
    schemaVersion: typeof a.schemaVersion === 'number' ? a.schemaVersion : ANKI_SCHEMA_VERSION,
    enabled: !!a.enabled,
    selectedDecks: Array.isArray(a.selectedDecks) ? a.selectedDecks : [],
    status: 'idle',
    lastSyncAt: typeof a.lastSyncAt === 'number' ? a.lastSyncAt : null,
    activeCollection: typeof a.activeCollection === 'string' ? a.activeCollection : null,
    pendingServerReset: false,
    collections
  };
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

    if (data.data.anki) {
      const cleanAnki = sanitizeImportedAnki(data.data.anki);
      if (cleanAnki) updates[STORAGE_KEYS.ANKI] = cleanAnki;
    }

    let isLoggedIn = false;
    if (includeSettings && data.data.settings) {
      const imported = { ...DEFAULT_SETTINGS, ...data.data.settings };
      imported.dayStartHour = Math.max(0, Math.min(6, imported.dayStartHour || 0));

      const userResult = await browser.storage.local.get(STORAGE_KEYS.USER);
      const userState = userResult[STORAGE_KEYS.USER] as JP343UserState | undefined;
      isLoggedIn = !!userState?.extApiToken;
      if (isLoggedIn) {
        delete (imported as Record<string, unknown>).blockedChannels;
        delete (imported as Record<string, unknown>).whitelistedChannels;
      }

      updates[STORAGE_KEYS.SETTINGS] = imported;
    }

    await browser.storage.local.set(updates);
    invalidateSessionCache();
    document.dispatchEvent(new CustomEvent('jp343:refresh'));

    if (includeSettings && isLoggedIn) {
      browser.runtime.sendMessage({ type: 'PULL_CHANNELS' }).catch(() => {});
    }

    const preview = statusContainer.querySelector('.import-preview');
    if (preview) preview.remove();

    const added = mergedEntries.length - localEntries.length;
    const msg = added > 0
      ? `${added} new sessions added` + (includeSettings ? ' and settings applied' : '')
      : 'No new sessions found (all already present)' + (includeSettings ? ', settings applied' : '');
    showStatus(statusContainer, msg, 'success');
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

  const mergedHourly: Record<string, number> = { ...(local.hourlyMinutes || {}) };
  for (const [hour, minutes] of Object.entries(imported.hourlyMinutes || {})) {
    mergedHourly[hour] = Math.max(mergedHourly[hour] || 0, minutes);
  }

  const totalMinutes = Object.values(mergedDaily).reduce((sum, m) => sum + m, 0);
  const lastActiveDate = local.lastActiveDate > (imported.lastActiveDate || '')
    ? local.lastActiveDate
    : (imported.lastActiveDate || local.lastActiveDate);
  const currentStreak = local.lastActiveDate >= (imported.lastActiveDate || '')
    ? local.currentStreak
    : (imported.currentStreak || local.currentStreak);

  return { totalMinutes, dailyMinutes: mergedDaily, lastActiveDate, currentStreak, hourlyMinutes: mergedHourly };
}

// ── Setup ────────────────────────────────────────────────

function ankiTodayReviews(state: AnkiState, dayStartHour: number): number {
  const col = state.activeCollection ? state.collections[state.activeCollection] : undefined;
  if (!col) return 0;
  const today = getLocalDateString(new Date(), dayStartHour);
  return col.days[today]?.reviews ?? 0;
}

function formatAnkiStatus(state: AnkiState, dayStartHour: number): string {
  switch (state.status) {
    case 'connected':
      return `Connected · ${ankiTodayReviews(state, dayStartHour)} reviews today`;
    case 'unreachable':
      return 'Not connected. Open the Anki desktop app to sync.';
    case 'permission_needed':
      return 'In Anki, click Yes on the permission popup, then press Test.';
    case 'api_key_required':
      return 'Remove the apiKey in your AnkiConnect config to allow syncing.';
    case 'error':
      return 'Could not read from Anki. Make sure it is open, then press Test.';
    default:
      return 'Not connected yet.';
  }
}

async function saveDeckSelection(allDecks: string[], list: HTMLElement): Promise<void> {
  const checked: string[] = [];
  list.querySelectorAll('input[type="checkbox"]').forEach(node => {
    const cb = node as HTMLInputElement;
    if (cb.checked && cb.dataset.deck) checked.push(cb.dataset.deck);
  });
  const decks = (checked.length === 0 || checked.length === allDecks.length) ? [] : checked;
  await browser.runtime.sendMessage({ type: 'SET_ANKI_DECKS', decks });
}

async function renderDeckPicker(container: HTMLElement): Promise<void> {
  container.textContent = '';
  const res = await browser.runtime.sendMessage({ type: 'GET_ANKI_DECKS' });
  const data = res?.success ? res.data as { decks: string[]; selected: string[]; reachable: boolean } : null;
  if (!data || !data.reachable) {
    const hint = document.createElement('div');
    hint.className = 'settings-row-desc';
    hint.textContent = 'Open Anki to choose which decks count.';
    container.appendChild(hint);
    return;
  }
  if (data.decks.length === 0) return;

  const label = document.createElement('div');
  label.className = 'settings-row-label';
  label.textContent = 'Decks counted for jp343';
  container.appendChild(label);

  const desc = document.createElement('div');
  desc.className = 'settings-row-desc';
  desc.textContent = 'All decks count by default. Uncheck a deck (e.g. another language) to leave it out.';
  container.appendChild(desc);

  const all = data.selected.length === 0;
  const selectedSet = new Set(data.selected);
  const list = document.createElement('div');
  list.className = 'anki-deck-list';
  for (const deck of data.decks) {
    const rowEl = document.createElement('label');
    rowEl.className = 'anki-deck-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = all || selectedSet.has(deck);
    cb.dataset.deck = deck;
    cb.addEventListener('change', () => saveDeckSelection(data.decks, list));
    const name = document.createElement('span');
    name.textContent = deck;
    rowEl.appendChild(cb);
    rowEl.appendChild(name);
    list.appendChild(rowEl);
  }
  container.appendChild(list);
}

async function refreshAnki(statusEl: HTMLElement, toggle: HTMLElement | null, deckContainer: HTMLElement): Promise<void> {
  const res = await browser.storage.local.get(STORAGE_KEYS.ANKI);
  const state = res[STORAGE_KEYS.ANKI] as AnkiState | undefined;
  if (toggle) toggle.classList.toggle('enabled', !!state?.enabled);
  if (!state || !state.enabled) {
    statusEl.textContent = 'Off. Enable to read your Anki review time and stats.';
    deckContainer.textContent = '';
    return;
  }
  const settings = await getFreshSettings();
  statusEl.textContent = formatAnkiStatus(state, settings.dayStartHour || 0);
  void renderDeckPicker(deckContainer);
}

function buildAnkiPanel(container: HTMLElement): void {
  const section = document.createElement('div');
  section.className = 'settings-section';

  const titleRow = document.createElement('div');
  titleRow.className = 'anki-title-row';
  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'Anki';
  const info = document.createElement('button');
  info.type = 'button';
  info.className = 'anki-info-btn';
  info.textContent = 'ⓘ';
  info.setAttribute('aria-label', 'How Anki tracking works');
  titleRow.appendChild(title);
  titleRow.appendChild(info);
  section.appendChild(titleRow);

  const help = document.createElement('div');
  help.className = 'anki-help';
  help.textContent = 'jp343 reads your study time and reviews straight from the Anki desktop app through the free AnkiConnect add-on. In Anki open Tools → Add-ons → Get Add-ons, paste the code 2055492159, then restart Anki and switch this on. The first time, Anki asks you to allow access, then click Yes. Desktop only; phone apps (AnkiDroid, AnkiMobile) cannot be read.';
  info.addEventListener('click', () => help.classList.toggle('open'));
  section.appendChild(help);

  const status = document.createElement('div');
  status.className = 'settings-row-desc';
  status.textContent = 'Checking…';

  const deckContainer = document.createElement('div');
  deckContainer.className = 'anki-deck-picker';

  let toggle: HTMLElement | null = null;
  const row = createToggleRow(
    'Track Anki review time',
    'Count your Anki study time, reviews and retention.',
    false,
    async (val) => {
      status.textContent = val ? 'Connecting…' : 'Off.';
      await browser.runtime.sendMessage({ type: 'SET_ANKI_ENABLED', enabled: val });
      await refreshAnki(status, toggle, deckContainer);
    }
  );
  toggle = row.querySelector('.settings-toggle') as HTMLElement | null;
  section.appendChild(row);
  section.appendChild(status);

  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'export-btn';
  testBtn.textContent = 'Test connection';
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    status.textContent = 'Connecting…';
    await browser.runtime.sendMessage({ type: 'ANKI_SYNC_NOW' });
    await refreshAnki(status, toggle, deckContainer);
    testBtn.disabled = false;
  });
  section.appendChild(testBtn);
  section.appendChild(deckContainer);

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'anki-reset-btn';
  resetBtn.textContent = 'Reset Anki data';
  let resetArmed = false;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;
  const disarmReset = () => {
    resetArmed = false;
    resetBtn.classList.remove('armed');
    resetBtn.textContent = 'Reset Anki data';
  };
  resetBtn.addEventListener('click', async () => {
    if (!resetArmed) {
      resetArmed = true;
      resetBtn.classList.add('armed');
      resetBtn.textContent = 'Click again to delete all Anki stats';
      resetTimer = setTimeout(disarmReset, 4000);
      return;
    }
    if (resetTimer) clearTimeout(resetTimer);
    disarmReset();
    resetBtn.disabled = true;
    resetBtn.textContent = 'Resetting…';
    await browser.runtime.sendMessage({ type: 'ANKI_RESET' });
    await refreshAnki(status, toggle, deckContainer);
    resetBtn.disabled = false;
    resetBtn.textContent = 'Reset Anki data';
  });
  section.appendChild(resetBtn);

  const resetDesc = document.createElement('div');
  resetDesc.className = 'settings-row-desc';
  resetDesc.textContent = 'Deletes your Anki stats here and on jp343.com. They rebuild from Anki on the next sync.';
  section.appendChild(resetDesc);

  container.appendChild(section);
  void refreshAnki(status, toggle, deckContainer);
}

function rebuildSettingsPanel(panel: HTMLElement, settings: ExtensionSettings): void {
  panel.textContent = '';
  buildAppearancePanel(panel, settings);
  buildTargetStartSection(panel, settings);
  buildTrackingPanel(panel, settings);
  buildPlatformsPanel(panel, settings);
  buildAnkiPanel(panel);
  buildDiagnosticsPanel(panel, settings);
  buildExportImportPanel(panel);
}

function buildWhitelistedPanel(container: HTMLElement, settings: ExtensionSettings): void {
  const card = document.createElement('div');
  card.className = 'card';

  const header = document.createElement('div');
  header.className = 'blocked-header';
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = 'Allowed Channels';
  title.style.marginBottom = '0';
  const count = document.createElement('span');
  count.className = 'blocked-count';
  count.id = 'settingsWhitelistedCount';
  count.textContent = `${settings.whitelistedChannels.length} allowed`;
  header.appendChild(title);
  header.appendChild(count);
  card.appendChild(header);

  const channels = settings.whitelistedChannels;
  const list = document.createElement('div');
  list.id = 'settingsWhitelistedList';

  if (channels.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'blocked-empty';
    empty.textContent = 'No allowed channels';
    list.appendChild(empty);
  } else {
    for (const channel of channels) {
      const row = document.createElement('div');
      row.className = 'blocked-row';
      const name = document.createElement('span');
      name.className = 'blocked-channel-name';
      name.textContent = channel.channelName;
      name.title = channel.channelName;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'blocked-unblock-btn';
      btn.textContent = 'Remove';
      btn.addEventListener('click', async () => {
        await browser.runtime.sendMessage({ type: 'UNWHITELIST_CHANNEL', channelId: channel.channelId });
        const idx = channels.findIndex(c => c.channelId === channel.channelId);
        if (idx !== -1) channels.splice(idx, 1);
        row.remove();
        const countEl = document.getElementById('settingsWhitelistedCount');
        if (countEl) countEl.textContent = `${channels.length} allowed`;
      });
      row.appendChild(name);
      row.appendChild(btn);
      list.appendChild(row);
    }
  }

  card.appendChild(list);
  container.appendChild(card);
}

function rebuildChannelsPanel(grid: HTMLElement, settings: ExtensionSettings): void {
  grid.textContent = '';
  const blockedCol = document.createElement('div');
  blockedCol.className = 'channels-col';
  buildBlockedPanel(blockedCol, settings);
  const allowedCol = document.createElement('div');
  allowedCol.className = 'channels-col';
  buildWhitelistedPanel(allowedCol, settings);
  grid.appendChild(blockedCol);
  grid.appendChild(allowedCol);
}

export async function setupSettings(): Promise<void> {
  const settingsPanel = document.getElementById('tabSettings');
  const channelsGrid = document.getElementById('channelsGrid');
  if (!settingsPanel || !channelsGrid) return;

  const result = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
  const settings: ExtensionSettings = { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEYS.SETTINGS] || {}) };
  rebuildSettingsPanel(settingsPanel, settings);
  rebuildChannelsPanel(channelsGrid, settings);
}
