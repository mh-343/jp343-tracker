// JP343 Extension - Popup UI

import { STORAGE_KEYS } from '../../types';
import type { TrackingSession, Platform, PendingEntry, BlockedChannel, WhitelistedChannel, ExtensionSettings, ActiveTabInfo, ActivityType, SpotifyContentType } from '../../types';
import { formatDuration, formatStatDuration, isValidImageUrl, formatSessionDate, getWeekDates } from '../../lib/format-utils';
import { initThemeToggle, applyColorTheme } from '../../lib/theme';

const DEBUG_MODE = import.meta.env.DEV;
const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};

const elements = {
  statusDot: document.getElementById('statusDot') as HTMLElement,
  statusText: document.getElementById('statusText') as HTMLElement,
  noSession: document.getElementById('noSession') as HTMLElement,
  activeSession: document.getElementById('activeSession') as HTMLElement,
  thumbnail: document.getElementById('thumbnail') as HTMLElement,
  platformIcon: document.getElementById('platformIcon') as HTMLElement,
  sessionTitle: document.getElementById('sessionTitle') as HTMLElement,
  sessionPlatform: document.getElementById('sessionPlatform') as HTMLElement,
  sessionTimer: document.getElementById('sessionTimer') as HTMLElement,
  adLabel: document.getElementById('adLabel') as HTMLElement,
  btnPause: document.getElementById('btnPause') as HTMLButtonElement,
  btnStop: document.getElementById('btnStop') as HTMLButtonElement,
  pendingSection: document.getElementById('pendingSection') as HTMLElement,
  pendingList: document.getElementById('pendingList') as HTMLElement,
  toggleEnabled: document.getElementById('toggleEnabled') as HTMLInputElement,
  toggleLabel: document.getElementById('toggleLabel') as HTMLElement,
  sessionCard: document.getElementById('sessionCard') as HTMLElement,
  channelSection: document.getElementById('channelSection') as HTMLElement,
  channelLabel: document.getElementById('channelLabel') as HTMLElement,
  currentChannelName: document.getElementById('currentChannelName') as HTMLElement,
  btnBlockChannel: document.getElementById('btnBlockChannel') as HTMLButtonElement,
  btnAllowChannel: document.getElementById('btnAllowChannel') as HTMLButtonElement,
  btnEditTitle: document.getElementById('btnEditTitle') as HTMLButtonElement,
  // Manual Tracking
  manualTrackMode: document.getElementById('manualTrackMode') as HTMLElement,
  currentDomain: document.getElementById('currentDomain') as HTMLElement,
  manualTitle: document.getElementById('manualTitle') as HTMLInputElement,
  activityTypeSelect: document.getElementById('activityType') as HTMLSelectElement,
  btnStartManual: document.getElementById('btnStartManual') as HTMLButtonElement,
  // Toast
  toast: document.getElementById('toast') as HTMLElement,
  // Stats Bar
  statWeek: document.getElementById('statWeek') as HTMLElement,
  statToday: document.getElementById('statToday') as HTMLElement,
  statStreak: document.getElementById('statStreak') as HTMLElement
};

const platformIcons: Record<Platform, string> = {
  youtube: '▶',
  netflix: 'N',
  crunchyroll: 'C',
  primevideo: 'P',
  disneyplus: 'D',
  cijapanese: '漢',
  spotify: '♪',
  generic: '⏵'
};

let currentSession: TrackingSession | null = null;
let updateInterval: ReturnType<typeof setInterval> | null = null;
let isEnabled = true;
let blockedChannels: BlockedChannel[] = [];
let whitelistedChannels: WhitelistedChannel[] = [];
let hideNonJapanese = false;
let trackJapaneseOnly = false;
let currentChannelId: string | null = null;
let lastSkippedChannel: { channelId: string; channelName: string; channelUrl: string | null; platform: string } | null = null;
let activeTabInfo: ActiveTabInfo | null = null;
let toastTimeout: ReturnType<typeof setTimeout> | null = null;
let fetchSeq = 0;

function showToast(message: string, type: 'warning' | 'success' = 'warning', duration = 3000): void {
  if (toastTimeout) {
    clearTimeout(toastTimeout);
  }

  elements.toast.textContent = message;
  elements.toast.className = `toast ${type} visible`;

  toastTimeout = setTimeout(() => {
    elements.toast.classList.remove('visible');
  }, duration);
}

function updateToggleDisplay(enabled: boolean): void {
  isEnabled = enabled;
  elements.toggleLabel.textContent = enabled ? 'ON' : 'OFF';
  elements.toggleLabel.classList.toggle('on', enabled);
  elements.toggleEnabled.checked = enabled;
  elements.sessionCard.classList.toggle('disabled', !enabled);
}

let _popupGoalMinutes = 60;
let _popupDayStartHour = 0;

function renderGoalMicroBar(todayMinutes: number): void {
  const fill = document.getElementById('goalMicroFill') as HTMLDivElement | null;
  if (!fill) return;
  const pct = Math.min(Math.round((todayMinutes / _popupGoalMinutes) * 100), 100);
  fill.style.width = `${pct}%`;
}

async function loadAndApplySettings(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (response.success && response.data?.settings) {
      const settings = response.data.settings as ExtensionSettings;
      updateToggleDisplay(settings.enabled);
      blockedChannels = settings.blockedChannels || [];
      updateSpotifyFilterUI(settings);
      _popupGoalMinutes = settings.dailyGoalMinutes ?? 60;
      _popupDayStartHour = Math.max(0, Math.min(6, settings.dayStartHour ?? 0));
      whitelistedChannels = settings.whitelistedChannels || [];
      hideNonJapanese = settings.hideNonJapanese ?? false;
      trackJapaneseOnly = settings.trackJapaneseOnly ?? false;
      updateJpFilterDisplay(hideNonJapanese);
      applyColorTheme(settings.colorTheme ?? 'magenta');
    }
  } catch (error) {
    log('[JP343 Popup] Failed to load settings:', error);
  }
}

function updateJpFilterDisplay(active: boolean): void {
  const btn = document.getElementById('btnJpFilter');
  if (!btn) return;
  btn.classList.toggle('active', active);
  btn.title = active ? 'JP filter: Hide non-Japanese' : 'JP filter: Off';
}

function updateSpotifyFilterUI(settings: ExtensionSettings): void {
  const section = document.getElementById('spotifyFilterSection');
  if (!section) return;
  const onSpotify = currentSession?.platform === 'spotify' || /open\.spotify\.com/.test(activeTabInfo?.url || '');
  section.style.display = onSpotify ? 'flex' : 'none';
  if (!onSpotify) return;
  const types = settings.spotifyContentTypes || ['podcast', 'music', 'audiobook'];
  section.querySelectorAll('.spotify-chip').forEach(chip => {
    const type = chip.getAttribute('data-type') as SpotifyContentType;
    chip.classList.toggle('active', types.includes(type));
  });
}

function initSpotifyFilterChips(): void {
  const section = document.getElementById('spotifyFilterSection');
  if (!section) return;
  section.querySelectorAll('.spotify-chip').forEach(chip => {
    chip.addEventListener('click', async () => {
      const type = chip.getAttribute('data-type') as SpotifyContentType;
      const isActive = chip.classList.contains('active');
      const response = await browser.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (!response.success) return;
      const settings = response.data.settings as ExtensionSettings;
      let types = settings.spotifyContentTypes || ['podcast', 'music', 'audiobook'];
      if (isActive) {
        types = types.filter(t => t !== type);
      } else {
        types.push(type);
      }
      settings.spotifyContentTypes = types;
      await browser.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings });
      chip.classList.toggle('active', !isActive);
    });
  });
}

// --- MANUAL TRACKING ---

let lastLoadedDomain = '';

async function loadActiveTabInfo(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({ type: 'GET_ACTIVE_TAB_INFO' });
    if (response.success && response.data) {
      activeTabInfo = response.data as ActiveTabInfo;
      updateManualTrackDisplay();
      loadAndApplySettings();
      if (activeTabInfo.domain?.includes('youtube.com')) {
        const jpBtn = document.getElementById('btnJpFilter');
        if (jpBtn) (jpBtn as HTMLElement).style.display = 'flex';
      }
      if (activeTabInfo.tabId) {
        browser.tabs.sendMessage(activeTabInfo.tabId, { type: 'TAB_ACTIVATED' }).catch(() => {});
      }
    }
  } catch (error) {
    log('[JP343 Popup] Failed to load tab info:', error);
  }
}

function updateManualTrackDisplay(): void {
  if (!activeTabInfo) {
    elements.manualTrackMode.style.display = 'none';
    return;
  }

  const shouldShowManual = !currentSession && !activeTabInfo.isStreamingSite;

  if (shouldShowManual) {
    elements.noSession.style.display = 'none';
    elements.manualTrackMode.style.display = 'block';
    elements.currentDomain.textContent = activeTabInfo.domain;
    elements.manualTitle.value = activeTabInfo.title;
    elements.manualTitle.placeholder = activeTabInfo.title;
    if (lastLoadedDomain !== activeTabInfo.domain) {
      lastLoadedDomain = activeTabInfo.domain;
      loadActivityTypePreference(activeTabInfo.domain);
    }
  } else {
    elements.manualTrackMode.style.display = 'none';
    if (!currentSession) {
      elements.noSession.style.display = 'block';
      const noSessionTitle = document.getElementById('noSessionTitle');
      const noSessionHint = document.getElementById('noSessionHint');
      if (activeTabInfo.isStreamingSite && noSessionTitle && noSessionHint) {
        noSessionTitle.textContent = 'Waiting for playback';
        noSessionHint.textContent = 'Start a video to auto-track';
      } else if (noSessionTitle && noSessionHint) {
        noSessionTitle.textContent = 'No active session';
        noSessionHint.textContent = 'Visit a supported streaming site to start tracking';
      }
    }
  }
}

async function loadActivityTypePreference(domain: string): Promise<void> {
  try {
    const result = await browser.storage.local.get(STORAGE_KEYS.ACTIVITY_PREFS);
    const prefs = result[STORAGE_KEYS.ACTIVITY_PREFS] as Record<string, ActivityType> | undefined;
    elements.activityTypeSelect.value = prefs?.[domain] ?? 'watching';
  } catch {
    elements.activityTypeSelect.value = 'watching';
  }
}

async function saveActivityTypePreference(domain: string, activityType: ActivityType): Promise<void> {
  try {
    const result = await browser.storage.local.get(STORAGE_KEYS.ACTIVITY_PREFS);
    const prefs = (result[STORAGE_KEYS.ACTIVITY_PREFS] as Record<string, ActivityType>) ?? {};
    prefs[domain] = activityType;
    await browser.storage.local.set({ [STORAGE_KEYS.ACTIVITY_PREFS]: prefs });
  } catch { /* non-critical */ }
}

elements.btnStartManual.addEventListener('click', async () => {
  if (!activeTabInfo) return;

  const title = elements.manualTitle.value.trim() || activeTabInfo.title;
  const activityType = elements.activityTypeSelect.value as ActivityType;

  await saveActivityTypePreference(activeTabInfo.domain, activityType);

  try {
    const response = await browser.runtime.sendMessage({
      type: 'MANUAL_TRACK_START',
      title: title,
      url: activeTabInfo.url,
      tabId: activeTabInfo.tabId,
      activityType
    });

    if (response.success) {
      await fetchCurrentState();
    } else {
      log('[JP343 Popup] Failed to start:', response.error);
    }
  } catch (error) {
    log('[JP343 Popup] Error:', error);
  }
});

elements.toggleEnabled.addEventListener('click', async () => {
  const newState = !isEnabled;
  try {
    await browser.runtime.sendMessage({ type: 'SET_ENABLED', enabled: newState });
    updateToggleDisplay(newState);
    await fetchCurrentState();
  } catch (error) {
    log('[JP343 Popup] Failed to toggle:', error);
  }
});

// --- CHANNEL BLOCKING ---

function isChannelBlocked(channelId: string): boolean {
  return blockedChannels.some(c => c.channelId === channelId);
}

function isChannelWhitelisted(channelId: string): boolean {
  return whitelistedChannels.some(c => c.channelId === channelId);
}

function updateChannelDisplay(
  session: TrackingSession | null,
  skippedChannel?: { channelId: string; channelName: string; channelUrl: string | null; platform: string } | null
): void {
  if (session && session.channelId) {
    currentChannelId = session.channelId;
    elements.channelSection.style.display = 'block';
    elements.channelLabel.textContent = session.platform === 'youtube' ? 'Channel' : 'Title';
    elements.currentChannelName.textContent = session.channelName || session.channelId;
    (elements.currentChannelName.parentElement as HTMLElement).style.display = '';
    const allowed = session.platform === 'youtube' && trackJapaneseOnly
      && isChannelWhitelisted(session.channelId);

    elements.btnBlockChannel.style.display = allowed ? 'none' : '';
    if (!allowed) {
      const blocked = isChannelBlocked(session.channelId);
      elements.btnBlockChannel.textContent = blocked ? 'Blocked' : 'Block';
      elements.btnBlockChannel.classList.toggle('blocked', blocked);
    }
    elements.btnAllowChannel.style.display = allowed ? '' : 'none';
    if (allowed) {
      elements.btnAllowChannel.textContent = 'Allowed';
      elements.btnAllowChannel.classList.add('allowed');
    }
  } else if (skippedChannel) {
    currentChannelId = skippedChannel.channelId;
    elements.channelSection.style.display = 'block';
    elements.channelLabel.textContent = 'Channel';
    elements.currentChannelName.textContent = skippedChannel.channelName || skippedChannel.channelId;
    (elements.currentChannelName.parentElement as HTMLElement).style.display = '';
    const blocked = isChannelBlocked(skippedChannel.channelId);
    if (blocked) {
      elements.btnBlockChannel.style.display = '';
      elements.btnBlockChannel.textContent = 'Blocked';
      elements.btnBlockChannel.classList.add('blocked');
      elements.btnAllowChannel.style.display = 'none';
    } else {
      elements.btnBlockChannel.style.display = 'none';
      elements.btnAllowChannel.style.display = '';
      const allowed = isChannelWhitelisted(skippedChannel.channelId);
      elements.btnAllowChannel.textContent = allowed ? 'Allowed' : 'Allow';
      elements.btnAllowChannel.classList.toggle('allowed', allowed);
    }
  } else {
    currentChannelId = null;
    elements.channelSection.style.display = blockedChannels.length > 0 ? 'block' : 'none';
    (elements.currentChannelName.parentElement as HTMLElement).style.display = 'none';
    elements.btnBlockChannel.style.display = 'none';
    elements.btnAllowChannel.style.display = 'none';
  }
}

async function blockChannel(): Promise<void> {
  if (!currentSession || !currentSession.channelId) return;

  const channel: BlockedChannel = {
    channelId: currentSession.channelId,
    channelName: currentSession.channelName || currentSession.channelId,
    channelUrl: currentSession.channelUrl,
    blockedAt: new Date().toISOString()
  };

  try {
    await browser.runtime.sendMessage({ type: 'BLOCK_CHANNEL', channel });
    blockedChannels.push(channel);
    whitelistedChannels = whitelistedChannels.filter(c => c.channelId !== channel.channelId);
    updateChannelDisplay(currentSession, lastSkippedChannel);
    log('[JP343 Popup] Channel blocked:', channel.channelName);
  } catch (error) {
    log('[JP343 Popup] Failed to block channel:', error);
  }
}

async function unblockChannel(channelId: string): Promise<void> {
  try {
    await browser.runtime.sendMessage({ type: 'UNBLOCK_CHANNEL', channelId });
    blockedChannels = blockedChannels.filter(c => c.channelId !== channelId);
    updateChannelDisplay(currentSession, lastSkippedChannel);
    log('[JP343 Popup] Channel unblocked:', channelId);
  } catch (error) {
    log('[JP343 Popup] Failed to unblock channel:', error);
  }
}

async function allowChannel(): Promise<void> {
  if (!currentChannelId) return;
  const channelName = currentSession?.channelName || elements.currentChannelName.textContent || currentChannelId;
  const channelUrl = currentSession?.channelUrl || null;
  const channel: WhitelistedChannel = {
    channelId: currentChannelId,
    channelName: channelName,
    channelUrl: channelUrl,
    whitelistedAt: new Date().toISOString()
  };
  try {
    await browser.runtime.sendMessage({ type: 'WHITELIST_CHANNEL', channel });
    whitelistedChannels.push(channel);
    blockedChannels = blockedChannels.filter(c => c.channelId !== channel.channelId);
    updateChannelDisplay(currentSession, lastSkippedChannel);
    log('[JP343 Popup] Channel whitelisted:', channel.channelName);
  } catch (error) {
    log('[JP343 Popup] Failed to whitelist channel:', error);
  }
}

async function unallowChannel(channelId: string): Promise<void> {
  try {
    await browser.runtime.sendMessage({ type: 'UNWHITELIST_CHANNEL', channelId });
    whitelistedChannels = whitelistedChannels.filter(c => c.channelId !== channelId);
    updateChannelDisplay(currentSession, lastSkippedChannel);
    log('[JP343 Popup] Channel unwhitelisted:', channelId);
  } catch (error) {
    log('[JP343 Popup] Failed to unwhitelist channel:', error);
  }
}

elements.btnBlockChannel.addEventListener('click', async () => {
  if (!currentChannelId) return;
  if (isChannelBlocked(currentChannelId)) {
    await unblockChannel(currentChannelId);
  } else {
    await blockChannel();
  }
});

elements.btnAllowChannel.addEventListener('click', async () => {
  if (!currentChannelId) return;
  if (isChannelWhitelisted(currentChannelId)) {
    await unallowChannel(currentChannelId);
  } else {
    await allowChannel();
  }
});

// --- TITLE EDITING ---

let isEditingTitle = false;

elements.btnEditTitle.addEventListener('click', () => {
  if (isEditingTitle || !currentSession) return;
  startTitleEdit();
});

function startTitleEdit(): void {
  if (!currentSession) return;
  isEditingTitle = true;

  const titleRow = elements.sessionTitle.parentElement;
  if (!titleRow) return;

  const currentTitle = elements.sessionTitle.textContent || '';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-title-input';
  input.value = currentTitle;

  elements.sessionTitle.style.display = 'none';
  elements.btnEditTitle.style.display = 'none';

  titleRow.insertBefore(input, elements.sessionTitle);
  input.focus();
  input.select();

  const saveEdit = async () => {
    const newTitle = input.value.trim();
    if (newTitle && newTitle !== currentTitle) {
      try {
        await browser.runtime.sendMessage({
          type: 'UPDATE_SESSION_TITLE',
          title: newTitle
        });
        elements.sessionTitle.textContent = newTitle;
        log('[JP343 Popup] Title updated:', newTitle);
      } catch (error) {
        log('[JP343 Popup] Failed to update title:', error);
      }
    }

    input.remove();
    elements.sessionTitle.style.display = '';
    elements.btnEditTitle.style.display = '';
    isEditingTitle = false;
  };

  input.addEventListener('blur', saveEdit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveEdit();
    }
    if (e.key === 'Escape') {
      input.value = currentTitle;
      saveEdit();
    }
  });
}

function updateStatus(session: TrackingSession | null, isAd: boolean): void {
  if (isAd) {
    elements.statusDot.className = 'status-dot ad';
    elements.statusText.textContent = 'Ad';
  } else if (!session) {
    elements.statusDot.className = 'status-dot';
    elements.statusText.textContent = 'Idle';
  } else if (session.isPaused) {
    elements.statusDot.className = 'status-dot paused';
    elements.statusText.textContent = 'Paused';
  } else if (session.isActive) {
    elements.statusDot.className = 'status-dot recording';
    elements.statusText.textContent = 'REC';
  }
}

function updateSessionDisplay(
  session: TrackingSession | null,
  duration: string,
  isAd: boolean
): void {
  if (!session) {
    elements.noSession.style.display = 'block';
    elements.activeSession.style.display = 'none';
    return;
  }

  elements.noSession.style.display = 'none';
  elements.activeSession.style.display = 'block';

  // XSS-safe: createElement instead of innerHTML
  if (session.thumbnailUrl && isValidImageUrl(session.thumbnailUrl)) {
    elements.thumbnail.textContent = '';
    const img = document.createElement('img');
    img.src = session.thumbnailUrl;
    img.className = 'session-thumbnail';
    img.alt = '';
    elements.thumbnail.appendChild(img);
  } else {
    elements.thumbnail.className = 'session-thumbnail placeholder';
    elements.platformIcon.textContent = platformIcons[session.platform] || '⏵';
  }

  elements.sessionTitle.textContent = session.title;
  if (session.platform === 'generic' && session.url) {
    try {
      const domain = new URL(session.url).hostname.replace(/^www\./, '');
      elements.sessionPlatform.textContent = domain;
    } catch {
      elements.sessionPlatform.textContent = 'Manual tracking';
    }
  } else {
    elements.sessionPlatform.textContent = session.platform + '.com';
  }

  elements.sessionTimer.textContent = duration;
  elements.sessionTimer.className = isAd ? 'session-timer ad' : 'session-timer';
  elements.adLabel.style.display = isAd ? 'block' : 'none';

  elements.btnPause.textContent = session.isPaused ? 'Resume' : 'Pause';
}

function updatePendingDisplay(entries: PendingEntry[]): void {
  elements.pendingSection.style.display = entries.length > 0 ? 'block' : 'none';
}

// Grouped entry for popup display
interface GroupedEntry {
  primary: PendingEntry;
  entries: PendingEntry[];
  entryIds: string[];
  totalMinutes: number;
  sessionCount: number;
  allSynced: boolean;
  hasError: boolean;
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
      if (!entry.synced) group.allSynced = false;
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
        allSynced: entry.synced,
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

function renderPendingList(entries: PendingEntry[]): void {
  updatePendingDisplay(entries);

  if (entries.length === 0) {
    elements.pendingList.innerHTML = '';
    return;
  }

  // Preserve expanded state before re-render
  const expandedGroups = new Set<string>();
  elements.pendingList.querySelectorAll('.session-details-list').forEach(el => {
    if ((el as HTMLElement).style.display !== 'none') {
      expandedGroups.add((el as HTMLElement).dataset.group || '');
    }
  });

  const grouped = groupEntriesByVideo(entries);
  const sorted = [...grouped]
    .sort((a, b) => new Date(b.primary.date).getTime() - new Date(a.primary.date).getTime())
    .slice(0, 5);

  elements.pendingList.innerHTML = sorted.map((group, groupIndex) => {
    const entry = group.primary;
    const hasMultipleSessions = group.sessionCount > 1;

    const sessionDetails = group.entries.map(e => `
      <div class="session-detail" data-id="${escapeHtml(e.id)}">
        <span class="session-detail-date">${formatSessionDate(e.date, _popupDayStartHour)}</span>
        <span class="session-detail-duration">${formatDuration(e.duration_min)}</span>
        <button class="session-detail-delete" data-id="${escapeHtml(e.id)}" title="Delete this session">×</button>
      </div>
    `).join('');

    const safeUrl = entry.url ? escapeHtml(entry.url) : '';
    const safeThumbnail = entry.thumbnail && isValidImageUrl(entry.thumbnail) ? escapeHtml(entry.thumbnail) : '';

    return `
    <div class="pending-entry-group ${group.allSynced ? 'synced' : ''}" data-group="${groupIndex}">
      <div class="pending-entry" data-ids="${escapeHtml(group.entryIds.join(','))}" data-url="${safeUrl}">
        <div class="pending-entry-thumb-wrap ${entry.url ? 'clickable' : ''}" data-url="${safeUrl}" title="${entry.url ? 'Open video' : ''}">
          ${safeThumbnail
            ? `<img src="${safeThumbnail}" class="pending-entry-thumb" alt="">`
            : `<div class="pending-entry-thumb" style="display:flex;align-items:center;justify-content:center;font-size:12px;">${platformIcons[entry.platform] || '⏵'}</div>`
          }
          ${entry.url ? '<span class="pending-entry-play">▶</span>' : ''}
        </div>
        <div class="pending-entry-info">
          <div class="pending-entry-title-row">
            <span class="pending-entry-title ${entry.url ? 'clickable' : ''}" data-ids="${escapeHtml(group.entryIds.join(','))}" data-url="${safeUrl}">${escapeHtml(entry.project)}</span>
            ${!group.allSynced ? `
              <button class="pending-entry-edit" data-id="${escapeHtml(entry.id)}" title="Edit title">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
                </svg>
              </button>
            ` : ''}
          </div>
          <div class="pending-entry-meta">
            ${escapeHtml(entry.platform)} · <strong>${formatDuration(group.totalMinutes)}</strong>
            ${hasMultipleSessions ? `<button class="pending-entry-expand" data-group="${groupIndex}" title="Show ${group.sessionCount} sessions">(${group.sessionCount}×) ▼</button>` : ''}
            ${entry.url && !group.allSynced ? `<button class="pending-entry-continue" data-url="${safeUrl}" title="Continue watching">Continue ▶</button>` : ''}
          </div>
        </div>
        <button class="pending-entry-delete" data-ids="${escapeHtml(group.entryIds.join(','))}" title="Delete all sessions">×</button>
      </div>
      ${hasMultipleSessions ? `
        <div class="session-details-list" data-group="${groupIndex}" style="display: none;">
          ${sessionDetails}
        </div>
      ` : ''}
    </div>
  `;
  }).join('');

  // Delete all entries in group
  elements.pendingList.querySelectorAll('.pending-entry-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ids = (btn as HTMLElement).dataset.ids;
      if (ids) {
        for (const entryId of ids.split(',')) {
          await deleteEntry(entryId);
        }
      }
    });
  });

  elements.pendingList.querySelectorAll('.pending-entry-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const entryId = (btn as HTMLElement).dataset.id;
      if (entryId) {
        startPendingEntryTitleEdit(entryId);
      }
    });
  });

  elements.pendingList.querySelectorAll('.pending-entry-thumb-wrap.clickable').forEach(thumb => {
    thumb.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = (thumb as HTMLElement).dataset.url;
      if (url && /^https?:\/\//i.test(url)) {
        browser.tabs.create({ url });
      }
    });
  });

  elements.pendingList.querySelectorAll('.pending-entry-title.clickable').forEach(title => {
    title.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = (title as HTMLElement).dataset.url;
      if (url && /^https?:\/\//i.test(url)) {
        browser.tabs.create({ url });
      }
    });
  });

  elements.pendingList.querySelectorAll('.pending-entry-continue').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const url = (btn as HTMLElement).dataset.url;
      if (url && /^https?:\/\//i.test(url)) {
        await browser.tabs.create({ url });
        window.close();
      }
    });
  });

  elements.pendingList.querySelectorAll('.pending-entry-expand').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const groupIndex = (btn as HTMLElement).dataset.group;
      const detailsList = elements.pendingList.querySelector(`.session-details-list[data-group="${groupIndex}"]`) as HTMLElement;
      if (detailsList) {
        const isExpanded = detailsList.style.display !== 'none';
        detailsList.style.display = isExpanded ? 'none' : 'block';
        btn.textContent = btn.textContent?.replace(isExpanded ? '▲' : '▼', isExpanded ? '▼' : '▲') || '';
      }
    });
  });

  elements.pendingList.querySelectorAll('.session-detail-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const entryId = (btn as HTMLElement).dataset.id;
      if (entryId) {
        await deleteEntry(entryId);
      }
    });
  });

  // Restore expanded state after re-render
  expandedGroups.forEach(groupIndex => {
    const detailsList = elements.pendingList.querySelector(`.session-details-list[data-group="${groupIndex}"]`) as HTMLElement;
    const expandBtn = elements.pendingList.querySelector(`.pending-entry-expand[data-group="${groupIndex}"]`) as HTMLElement;
    if (detailsList) {
      detailsList.style.display = 'block';
      if (expandBtn) {
        expandBtn.textContent = expandBtn.textContent?.replace('▼', '▲') || '';
      }
    }
  });
}

function startPendingEntryTitleEdit(entryId: string): void {
  const editBtn = elements.pendingList.querySelector(`.pending-entry-edit[data-id="${entryId}"]`) as HTMLElement;
  const titleSpan = editBtn?.parentElement?.querySelector('.pending-entry-title') as HTMLElement;
  if (!titleSpan) return;

  const titleRow = titleSpan.parentElement;
  if (!titleRow) return;

  const currentTitle = titleSpan.textContent || '';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'pending-entry-title-input';
  input.value = currentTitle;

  titleSpan.style.display = 'none';
  if (editBtn) editBtn.style.display = 'none';

  titleRow.insertBefore(input, titleSpan);
  input.focus();
  input.select();

  const saveEdit = async () => {
    const newTitle = input.value.trim();
    if (newTitle && newTitle !== currentTitle) {
      // Update all entry IDs in the group
      const allIds = titleSpan.dataset.ids?.split(',') || [entryId];
      try {
        for (const id of allIds) {
          await browser.runtime.sendMessage({
            type: 'UPDATE_PENDING_ENTRY_TITLE',
            entryId: id,
            title: newTitle
          });
        }
        titleSpan.textContent = newTitle;
        log('[JP343 Popup] Pending entry title updated:', newTitle, `(${allIds.length} entries)`);
      } catch (error) {
        log('[JP343 Popup] Failed to update title:', error);
      }
    }

    input.remove();
    titleSpan.style.display = '';
    if (editBtn) editBtn.style.display = '';
  };

  input.addEventListener('blur', saveEdit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveEdit();
    }
    if (e.key === 'Escape') {
      input.value = currentTitle;
      saveEdit();
    }
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function deleteEntry(entryId: string): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({
      type: 'DELETE_PENDING_ENTRY',
      entryId
    });

    if (response.success) {
      await fetchPendingEntries();
      await fetchCurrentState();
    }
  } catch (error) {
    log('[JP343 Popup] Failed to delete:', error);
  }
}

async function fetchPendingEntries(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({ type: 'GET_PENDING_ENTRIES' });

    if (response.success && response.data?.entries) {
      renderPendingList(response.data.entries);
    }
  } catch (error) {
    log('[JP343 Popup] Failed to load entries:', error);
  }
}

async function fetchCurrentState(): Promise<void> {
  const seq = ++fetchSeq;
  try {
    const response = await browser.runtime.sendMessage({ type: 'GET_CURRENT_SESSION' });
    if (seq !== fetchSeq) return;

    if (response.success && response.data) {
      const { session, duration, isAd, skippedChannel } = response.data;
      lastSkippedChannel = skippedChannel || null;

      const platformChanged = currentSession?.platform !== session?.platform;
      currentSession = session;
      updateStatus(session, isAd);
      updateSessionDisplay(session, duration, isAd);
      updateChannelDisplay(session, skippedChannel);
      updateManualTrackDisplay();
      if (platformChanged) {
        loadAndApplySettings();
      }
    }
  } catch (error) {
    log('[JP343 Popup] Failed to load:', error);
  }
}

elements.btnPause.addEventListener('click', async () => {
  if (!currentSession) return;

  const action = currentSession.isPaused ? 'RESUME_SESSION' : 'PAUSE_SESSION';

  try {
    await browser.runtime.sendMessage({ type: action });
    await fetchCurrentState();
  } catch (error) {
    log('[JP343 Popup] Error:', error);
  }
});

elements.btnStop.addEventListener('click', async () => {
  try {
    const response = await browser.runtime.sendMessage({ type: 'STOP_SESSION' });

    if (response.success) {
      await fetchCurrentState();
      await fetchPendingEntries();

      if (response.saved === false) {
        showToast('Session too short (min. 1 minute)', 'warning');
      }
    }
  } catch (error) {
    log('[JP343 Popup] Error:', error);
  }
});

document.getElementById('btnDashboard')?.addEventListener('click', () => {
  const dashboardUrl = browser.runtime.getURL('/dashboard.html');
  browser.tabs.create({ url: dashboardUrl });
  window.close();
});

document.getElementById('btnSettings')?.addEventListener('click', () => {
  const settingsUrl = browser.runtime.getURL('/dashboard.html') + '?tab=settings';
  browser.tabs.create({ url: settingsUrl });
  window.close();
});

document.getElementById('btnJpFilter')?.addEventListener('click', async () => {
  try {
    const response = await browser.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (!response.success) return;
    const settings = response.data.settings as ExtensionSettings;
    settings.hideNonJapanese = !settings.hideNonJapanese;
    await browser.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings });
    hideNonJapanese = settings.hideNonJapanese;
    updateJpFilterDisplay(hideNonJapanese);
  } catch (error) {
    log('[JP343 Popup] Failed to cycle JP mode:', error);
  }
});

// --- STATS BAR ---

function renderWeekBars(dailyMinutes: Record<string, number>): void {
  const container = document.getElementById('weekBars');
  if (!container) return;

  const days = getWeekDates(_popupDayStartHour);
  const maxVal = Math.max(1, ...days.map(d => dailyMinutes[d.date] || 0));

  container.replaceChildren();
  for (const { date, label, isToday } of days) {
    const minutes = dailyMinutes[date] || 0;
    const heightPx = minutes > 0 ? Math.max(2, Math.round((minutes / maxVal) * 24)) : 2;

    const item = document.createElement('div');
    item.className = 'week-bar-item';

    const track = document.createElement('div');
    track.className = 'week-bar-track';

    const fill = document.createElement('div');
    fill.className = minutes === 0 ? 'week-bar-fill empty' : isToday ? 'week-bar-fill today' : 'week-bar-fill';
    fill.style.height = heightPx + 'px';

    const labelEl = document.createElement('span');
    labelEl.className = 'week-bar-label';
    labelEl.textContent = label;

    track.appendChild(fill);
    item.appendChild(track);
    item.appendChild(labelEl);
    container.appendChild(item);
  }

  container.style.display = 'flex';
}

async function fetchAndRenderStats(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({ type: 'GET_STATS' });
    if (response?.success && response.data) {
      const { weekMinutes, todayMinutes, streak, rawDailyMinutes } = response.data;
      elements.statWeek.textContent = formatStatDuration(weekMinutes || 0);
      elements.statToday.textContent = formatStatDuration(todayMinutes || 0);
      elements.statStreak.textContent = `${streak || 0}d`;
      renderGoalMicroBar(todayMinutes || 0);
      if (rawDailyMinutes) {
        renderWeekBars(rawDailyMinutes);
      }
    }
  } catch (error) {
    log('[JP343 Popup] Stats fetch failed:', error);
  }
}


// Theme Toggle
initThemeToggle('themeTogglePopup');

// Init
loadAndApplySettings();
initSpotifyFilterChips();
loadActiveTabInfo();
fetchCurrentState();
fetchPendingEntries();
fetchAndRenderStats();

updateInterval = setInterval(fetchCurrentState, 1000);
const pendingInterval = setInterval(fetchPendingEntries, 5000);
const statsInterval = setInterval(fetchAndRenderStats, 60000);

window.addEventListener('unload', () => {
  if (updateInterval) {
    clearInterval(updateInterval);
  }
  clearInterval(pendingInterval);
  clearInterval(statsInterval);
});
