import type { ExtensionSettings, Platform, SpotifyContentType, ColorTheme, MokuroState } from '../../types';
import { STORAGE_KEYS, DEFAULT_SETTINGS, COLOR_THEMES } from '../../types';
import { resizeImage, saveBackground, loadBackground, removeBackground, applyDashboardBackground, clearBackgroundDom } from '../../lib/background-image';
import { applyColorTheme } from '../../lib/theme';
import { buildTargetStartSection } from './target-start-settings';
import { getSettings, getFreshSettings, updateSettings, createToggleRow, showStatus } from './settings-helpers';
import { buildExportImportPanel } from './settings-backup';
import { buildAnkiPanel } from './settings-anki';
import { rebuildChannelsPanel } from './settings-channels';
import { hasMokuroPermission, requestMokuroPermission } from './mokuro-permission';

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
  mokuro: 'Mokuro',
  generic: 'Generic'
};

const CONTENT_TYPE_LABELS: Record<SpotifyContentType, string> = {
  music: 'Music',
  podcast: 'Podcasts',
  audiobook: 'Audiobooks'
};

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

function buildDifficultyPanel(container: HTMLElement, settings: ExtensionSettings): void {
  const section = document.createElement('div');
  section.className = 'settings-section';

  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'Difficulty levels';
  section.appendChild(title);

  section.appendChild(createToggleRow(
    'Show difficulty levels',
    'Level badge on YouTube videos, fetches a small anonymous data file from jp343.com daily',
    settings.showDifficultyLevels ?? true,
    async (val) => { await updateSettings({ showDifficultyLevels: val }); }
  ));

  section.appendChild(createToggleRow(
    'Local estimate only',
    'Estimate difficulty on-device from the subtitles, never fetch the jp343.com data file',
    settings.difficultyLocalOnly ?? false,
    async (val) => { await updateSettings({ difficultyLocalOnly: val }); }
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


async function refreshMokuro(statusEl: HTMLElement, toggle: HTMLElement | null, regrantBtn: HTMLElement | null): Promise<void> {
  const res = await browser.runtime.sendMessage({ type: 'GET_MOKURO_STATE' }) as { data?: { mokuroState?: MokuroState } };
  const state = res?.data?.mokuroState;
  const enabled = !!state?.enabled;
  if (toggle) toggle.classList.toggle('enabled', enabled);
  if (regrantBtn) regrantBtn.style.display = 'none';
  if (!enabled) {
    statusEl.textContent = 'Off. Enable to read your Mokuro reading time.';
    return;
  }
  if (!(await hasMokuroPermission())) {
    statusEl.textContent = 'Access to reader.mokuro.app was turned off. Re-allow it to keep tracking.';
    if (regrantBtn) regrantBtn.style.display = '';
    return;
  }
  const mins = Math.round(state?.totalMinutes ?? 0);
  const when = state?.lastSyncAt ? new Date(state.lastSyncAt).toLocaleDateString() : 'never';
  statusEl.textContent = `Tracking. ${mins} min read so far. Last update: ${when}.`;
}

function buildMokuroPanel(container: HTMLElement): void {
  const section = document.createElement('div');
  section.className = 'settings-section';

  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'Mokuro (beta)';
  section.appendChild(title);

  const help = document.createElement('div');
  help.className = 'settings-row-desc';
  help.textContent = 'jp343 reads your manga reading time from reader.mokuro.app and counts it as reading immersion. Turn this on, allow access when asked, then reload your Mokuro tab. Your reading time stays on your device until it syncs to your account.';
  section.appendChild(help);

  const status = document.createElement('div');
  status.className = 'settings-row-desc';
  status.textContent = 'Checking…';

  let toggle: HTMLElement | null = null;

  const regrantBtn = document.createElement('button');
  regrantBtn.type = 'button';
  regrantBtn.className = 'mokuro-regrant-btn';
  regrantBtn.textContent = 'Re-allow access';
  regrantBtn.style.display = 'none';
  regrantBtn.addEventListener('click', async () => {
    if (await requestMokuroPermission()) await refreshMokuro(status, toggle, regrantBtn);
  });

  const row = createToggleRow(
    'Track Mokuro reading time',
    'Count your reader.mokuro.app reading as immersion.',
    false,
    async (val) => {
      if (val && !(await requestMokuroPermission())) {
        if (toggle) toggle.classList.remove('enabled');
        status.textContent = 'Allow access to reader.mokuro.app to turn this on.';
        return;
      }
      await browser.runtime.sendMessage({ type: 'SET_MOKURO_ENABLED', enabled: val });
      await refreshMokuro(status, toggle, regrantBtn);
    }
  );
  toggle = row.querySelector('.settings-toggle') as HTMLElement | null;
  section.appendChild(row);
  section.appendChild(status);
  section.appendChild(regrantBtn);
  container.appendChild(section);

  // Sync status on external grant/revoke
  const onPermissionChange = (perms: { origins?: string[] }): void => {
    if (!perms.origins?.some(o => o.includes('reader.mokuro.app'))) return;
    void refreshMokuro(status, toggle, regrantBtn);
  };
  browser.permissions.onAdded.addListener(onPermissionChange);
  browser.permissions.onRemoved.addListener(onPermissionChange);

  void refreshMokuro(status, toggle, regrantBtn);
}

function rebuildSettingsPanel(panel: HTMLElement, settings: ExtensionSettings): void {
  panel.textContent = '';
  buildAppearancePanel(panel, settings);
  buildTargetStartSection(panel, settings);
  buildTrackingPanel(panel, settings);
  buildDifficultyPanel(panel, settings);
  buildPlatformsPanel(panel, settings);
  buildAnkiPanel(panel);
  buildMokuroPanel(panel);
  buildDiagnosticsPanel(panel, settings);
  buildExportImportPanel(panel);
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
