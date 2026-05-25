// JP343 Extension - Popup UI

import { STORAGE_KEYS } from '../../types';
import type { TrackingSession, Platform, PendingEntry, BlockedChannel, WhitelistedChannel, ExtensionSettings, ActiveTabInfo, ActivityType, SpotifyContentType } from '../../types';
import { formatDuration, formatDurationMs, formatStatDuration, isValidImageUrl, formatSessionDate, getWeekDates } from '../../lib/format-utils';
import { initThemeToggle, applyColorTheme } from '../../lib/theme';
import { reportError, flushErrors } from '../../lib/error-reporter';

const DEBUG_MODE = import.meta.env.DEV;
const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};

window.addEventListener('error', (event) => {
  reportError(event.message || 'Unknown error', event.filename || 'popup/main.ts', event.error?.stack || '', 'popup');
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  reportError(reason?.message || String(reason), 'popup/main.ts', reason?.stack || '', 'popup');
});

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
  pendingHeader: document.getElementById('pendingHeader') as HTMLElement,
  pendingCollapseArrow: document.getElementById('pendingCollapseArrow') as HTMLElement,
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
  statStreak: document.getElementById('statStreak') as HTMLElement,
  resizeGrabber: document.getElementById('resizeGrabber') as HTMLElement
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
let isFetchingState = false;
let baseDurationMs = 0;
let baseTimestamp = 0;
let sessionTicking = false;
let lastDisplayedSecond = -1;

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
let _popupStretchEnabled = true;

function createGoalTooltipText<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className: string,
  text: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  return element;
}

function createGoalTooltipChip(text: string, isLevel = false): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.className = `goal-tooltip-chip${isLevel ? ' is-level' : ''}`;
  chip.textContent = text;
  return chip;
}

function renderGoalMicroBar(todayMinutes: number): void {
  const fill = document.getElementById('goalMicroFill') as HTMLDivElement | null;
  if (!fill) return;
  const bar = fill.parentElement;
  const wrap = document.getElementById('goalMicroWrap') as HTMLDivElement | null;
  const tooltip = document.getElementById('goalTooltip') as HTMLDivElement | null;
  const safeGoal = _popupGoalMinutes || 60;
  const progress = Math.round((todayMinutes / safeGoal) * 100);
  const isOverflow = progress >= 100;
  const timeStr = formatDuration(todayMinutes);
  const goalStr = formatDuration(safeGoal);

  fill.classList.remove('overflow', 'stretch');
  if (bar) bar.classList.remove('overflow');
  fill.style.background = '';
  fill.style.removeProperty('--goal-cutoff');
  if (wrap) {
    delete wrap.dataset.level;
    wrap.dataset.goalState = isOverflow ? (_popupStretchEnabled ? 'stretch' : 'complete') : 'progress';
  }

  let currentLevel = 0;
  let detailText = '';

  if (isOverflow && _popupStretchEnabled) {
    const ratio = todayMinutes / safeGoal;
    const thresholds = [1.0, 1.5, 2.0, 2.5, 3.0];
    currentLevel = 1;
    for (let i = thresholds.length - 1; i >= 0; i--) {
      if (ratio >= thresholds[i]) { currentLevel = i + 1; break; }
    }

    if (wrap) wrap.dataset.level = String(currentLevel);

    const levelIdx = currentLevel - 1;
    const start = thresholds[levelIdx];
    const end = levelIdx + 1 < thresholds.length ? thresholds[levelIdx + 1] : null;

    if (end !== null) {
      const intra = Math.round(((ratio - start) / (end - start)) * 100);
      fill.style.width = `${Math.min(intra, 100)}%`;
      fill.classList.add('stretch');
    } else if (ratio > 3.0) {
      fill.style.width = '100%';
      fill.classList.add('stretch', 'overflow');
      if (bar) bar.classList.add('overflow');
      const overProgress = Math.round(((ratio - 3.0) / 0.5) * 100);
      const cutoff = Math.round((100 / overProgress) * 100);
      fill.style.setProperty('--goal-cutoff', `${cutoff}%`);
      if (wrap) wrap.dataset.goalState = 'overflow';
    } else {
      fill.style.width = '100%';
      fill.classList.add('stretch');
    }
  } else if (isOverflow) {
    fill.style.width = '100%';
    fill.classList.add('overflow');
    if (bar) bar.classList.add('overflow');
    const cutoff = (100 / progress) * 100;
    fill.style.background = `linear-gradient(90deg, var(--accent) ${cutoff}%, var(--gradient-secondary) ${cutoff}%)`;
    fill.style.setProperty('--goal-cutoff', `${cutoff}%`);
  } else {
    fill.style.width = `${progress}%`;
  }

  if (!tooltip) return;

  const header = document.createElement('div');
  header.className = 'goal-tooltip-header';
  header.append(
    createGoalTooltipText('span', 'goal-tooltip-kicker', 'Today'),
    createGoalTooltipText('strong', 'goal-tooltip-value', timeStr)
  );

  const metrics = document.createElement('div');
  metrics.className = 'goal-tooltip-metrics';
  metrics.appendChild(createGoalTooltipChip(`${progress}%`));

  if (currentLevel > 0) {
    metrics.appendChild(createGoalTooltipChip(`Stretch ${currentLevel}/5`, true));
  }

  metrics.appendChild(createGoalTooltipChip(`Goal: ${goalStr}`));

  if (todayMinutes < safeGoal) {
    detailText = `${formatDuration(safeGoal - todayMinutes)} left to reach your goal`;
  } else if (currentLevel > 0) {
    if (currentLevel >= 5) {
      detailText = `${formatDuration(todayMinutes - safeGoal * 3)} past the final stretch`;
    } else {
      const nextThreshold = [1.5, 2.0, 2.5, 3.0][currentLevel - 1];
      const nextTime = safeGoal * nextThreshold;
      detailText = `${formatDuration(nextTime - todayMinutes)} until stretch ${currentLevel + 1}/5`;
    }
  } else {
    detailText = `${formatDuration(todayMinutes - safeGoal)} past your goal`;
  }

  const card = document.createElement('div');
  card.className = 'goal-tooltip-card';
  card.append(
    header,
    metrics,
    createGoalTooltipText('div', 'goal-tooltip-note', detailText)
  );

  tooltip.replaceChildren(card);

  if (wrap) {
    wrap.setAttribute(
      'aria-label',
      `Daily goal progress. Today ${timeStr}. ${progress}% of goal. ${detailText}.`
    );
  }
}

const goalWrap = document.getElementById('goalMicroWrap');
if (goalWrap) {
  goalWrap.addEventListener('click', (e) => {
    e.stopPropagation();
    goalWrap.classList.toggle('tooltip-open');
  });
  document.addEventListener('click', () => {
    goalWrap.classList.remove('tooltip-open');
  });
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
      _popupStretchEnabled = settings.stretchGoalsEnabled ?? true;
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

function tickTimerDisplay(): void {
  if (!currentSession) {
    lastDisplayedSecond = -1;
    return;
  }
  let displayMs = baseDurationMs;
  if (sessionTicking) {
    displayMs += Date.now() - baseTimestamp;
  }
  const displaySecond = Math.floor(displayMs / 1000);
  if (displaySecond < lastDisplayedSecond) return;
  lastDisplayedSecond = displaySecond;
  elements.sessionTimer.textContent = formatDurationMs(displayMs);
}

function updateSessionDisplay(
  session: TrackingSession | null,
  isAd: boolean
): void {
  if (!session) {
    elements.noSession.style.display = 'block';
    elements.activeSession.style.display = 'none';
    return;
  }

  elements.noSession.style.display = 'none';
  elements.activeSession.style.display = 'block';

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

  elements.sessionTimer.className = isAd ? 'session-timer ad' : 'session-timer';
  elements.adLabel.style.display = isAd ? 'block' : 'none';

  elements.btnPause.textContent = session.isPaused ? 'Resume' : 'Pause';
}

function updatePendingDisplay(entries: PendingEntry[]): void {
  elements.pendingSection.style.display = entries.length > 0 ? 'flex' : 'none';
}

// Grouped entry for popup display
interface GroupedEntry {
  primary: PendingEntry;
  entries: PendingEntry[];
  entryIds: string[];
  totalMinutes: number;
  sessionCount: number;
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

function renderEntryGroup(group: GroupedEntry): HTMLElement {
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
    placeholder.textContent = platformIcons[entry.platform] || '\u23f5';
    thumbWrap.appendChild(placeholder);
  }
  if (entry.url) {
    const playIcon = document.createElement('span');
    playIcon.className = 'pending-entry-play';
    playIcon.textContent = '\u25b6';
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

  const meta = document.createElement('div');
  meta.className = 'pending-entry-meta';
  const platformLabel = entry.platform === 'generic' && entry.activityType ? entry.activityType : entry.platform;
  meta.append(`${platformLabel} \u00b7 `);
  const strong = document.createElement('strong');
  strong.textContent = formatDuration(group.totalMinutes);
  meta.appendChild(strong);

  if (hasMultiple) {
    const expandBtn = document.createElement('button');
    expandBtn.className = 'pending-entry-expand';
    expandBtn.dataset.groupKey = groupKey;
    expandBtn.title = `Show ${group.sessionCount} sessions`;
    expandBtn.textContent = `(${group.sessionCount}\u00d7) \u25bc`;
    meta.appendChild(expandBtn);
  }
  if (entry.url) {
    const continueBtn = document.createElement('button');
    continueBtn.className = 'pending-entry-continue';
    continueBtn.dataset.url = entry.url;
    continueBtn.title = 'Continue watching';
    continueBtn.textContent = 'Continue \u25b6';
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
      dateSpan.textContent = formatSessionDate(e.date, _popupDayStartHour);
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

function renderPendingList(entries: PendingEntry[]): void {
  updatePendingDisplay(entries);

  if (entries.length === 0) {
    elements.pendingList.innerHTML = '';
    return;
  }

  const expandedGroups = new Set<string>();
  elements.pendingList.querySelectorAll('.session-details-list').forEach(el => {
    if ((el as HTMLElement).style.display !== 'none') {
      expandedGroups.add((el as HTMLElement).dataset.groupKey || '');
    }
  });

  const grouped = groupEntriesByVideo(entries);
  const sorted = [...grouped]
    .sort((a, b) => new Date(b.primary.date).getTime() - new Date(a.primary.date).getTime())
    .slice(0, 8);

  elements.pendingList.textContent = '';
  for (const g of sorted) {
    elements.pendingList.appendChild(renderEntryGroup(g));
  }

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
      const groupKey = (btn as HTMLElement).dataset.groupKey;
      const detailsList = elements.pendingList.querySelector(`.session-details-list[data-group-key="${groupKey}"]`) as HTMLElement;
      if (detailsList) {
        const isExpanded = detailsList.style.display !== 'none';
        detailsList.style.display = isExpanded ? 'none' : 'block';
        btn.textContent = btn.textContent?.replace(isExpanded ? '▲' : '▼', isExpanded ? '▼' : '▲') || '';
      }
    });
  });

  expandedGroups.forEach(groupKey => {
    const detailsList = elements.pendingList.querySelector(`.session-details-list[data-group-key="${groupKey}"]`) as HTMLElement;
    const expandBtn = elements.pendingList.querySelector(`.pending-entry-expand[data-group-key="${groupKey}"]`) as HTMLElement;
    if (detailsList) {
      detailsList.style.display = 'block';
      if (expandBtn) {
        expandBtn.textContent = expandBtn.textContent?.replace('▼', '▲') || '';
      }
    }
  });
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
  if (isFetchingState) return;
  isFetchingState = true;
  const seq = ++fetchSeq;
  try {
    const response = await browser.runtime.sendMessage({ type: 'GET_CURRENT_SESSION' });
    if (seq !== fetchSeq) return;

    if (response.success && response.data) {
      const { session, durationMs, isAd, skippedChannel } = response.data;
      lastSkippedChannel = skippedChannel || null;

      const newDurationMs = typeof durationMs === 'number' ? durationMs : 0;
      const newTicking = !!session && session.isActive && !session.isPaused && !isAd;
      const sessionChanged = session?.id !== currentSession?.id;
      const stateChanged = newTicking !== sessionTicking;

      if (sessionChanged) lastDisplayedSecond = -1;

      if (sessionChanged || stateChanged || !sessionTicking) {
        baseDurationMs = newDurationMs;
        baseTimestamp = Date.now();
      }
      sessionTicking = newTicking;

      const platformChanged = currentSession?.platform !== session?.platform;
      currentSession = session;
      updateStatus(session, isAd);
      updateSessionDisplay(session, isAd);
      tickTimerDisplay();
      updateChannelDisplay(session, skippedChannel);
      updateManualTrackDisplay();
      if (platformChanged) {
        loadAndApplySettings();
      }
    }
  } catch (error) {
    log('[JP343 Popup] Failed to load:', error);
  } finally {
    isFetchingState = false;
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

async function openOrFocusDashboard(path: string): Promise<void> {
  const baseUrl = browser.runtime.getURL('/dashboard.html');
  const existing = await browser.tabs.query({ url: baseUrl });
  if (existing.length > 0 && existing[0].id != null) {
    const tab = existing[0];
    const targetUrl = browser.runtime.getURL(path);
    await browser.tabs.update(tab.id!, { active: true, url: targetUrl });
    try { await browser.windows.update(tab.windowId!, { focused: true }); } catch { /* unavailable on Android */ }
  } else {
    await browser.tabs.create({ url: browser.runtime.getURL(path) });
  }
  window.close();
}

document.getElementById('btnDashboard')?.addEventListener('click', async () => {
  await openOrFocusDashboard('/dashboard.html');
});

document.getElementById('btnSettings')?.addEventListener('click', async () => {
  await openOrFocusDashboard('/dashboard.html?tab=settings');
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

// Sessions-Collapse: State aus Storage laden + Toggle
let sessionsCollapsed = false;
browser.storage.local.get(STORAGE_KEYS.COLLAPSED_CARDS).then(result => {
  const collapsed: string[] = result[STORAGE_KEYS.COLLAPSED_CARDS] || [];
  if (collapsed.includes('popup-sessions')) {
    sessionsCollapsed = true;
    elements.pendingList.style.display = 'none';
    elements.pendingCollapseArrow.style.transform = 'rotate(-90deg)';
  }
});
elements.pendingHeader.addEventListener('click', () => {
  sessionsCollapsed = !sessionsCollapsed;
  elements.pendingList.style.display = sessionsCollapsed ? 'none' : '';
  elements.pendingCollapseArrow.style.transform = sessionsCollapsed ? 'rotate(-90deg)' : '';
  browser.storage.local.get(STORAGE_KEYS.COLLAPSED_CARDS).then(result => {
    const current: string[] = result[STORAGE_KEYS.COLLAPSED_CARDS] || [];
    const updated = sessionsCollapsed
      ? [...current.filter(id => id !== 'popup-sessions'), 'popup-sessions']
      : current.filter(id => id !== 'popup-sessions');
    browser.storage.local.set({ [STORAGE_KEYS.COLLAPSED_CARDS]: updated });
  });
});

const POPUP_MIN_HEIGHT = 450;
const POPUP_MAX_HEIGHT = 600;

function initResizeGrabber(): void {
  const grabber = elements.resizeGrabber;
  let isDragging = false;

  function saveHeight(): void {
    const h = document.body.offsetHeight;
    browser.storage.local.set({ [STORAGE_KEYS.POPUP_HEIGHT]: h }).catch(() => {});
  }

  function startDrag(startY: number): void {
    const startHeight = document.body.offsetHeight;
    isDragging = true;
    grabber.classList.add('dragging');

    function applyDelta(currentY: number): void {
      const delta = currentY - startY;
      const newHeight = Math.min(POPUP_MAX_HEIGHT, Math.max(POPUP_MIN_HEIGHT, startHeight + delta));
      document.body.style.height = `${newHeight}px`;
    }

    function endDrag(): void {
      isDragging = false;
      grabber.classList.remove('dragging');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      saveHeight();
    }

    const onMouseMove = (e: MouseEvent) => applyDelta(e.clientY);
    const onMouseUp = () => endDrag();
    const onTouchMove = (e: TouchEvent) => { e.preventDefault(); applyDelta(e.touches[0].clientY); };
    const onTouchEnd = () => endDrag();

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
  }

  grabber.addEventListener('mousedown', (e: MouseEvent) => { e.preventDefault(); startDrag(e.clientY); });
  grabber.addEventListener('touchstart', (e: TouchEvent) => { e.preventDefault(); startDrag(e.touches[0].clientY); }, { passive: false });

  window.addEventListener('blur', () => {
    if (isDragging) saveHeight();
  });

  grabber.addEventListener('dblclick', () => {
    document.body.style.height = '';
    browser.storage.local.remove(STORAGE_KEYS.POPUP_HEIGHT).catch(() => {});
  });
}

browser.storage.local.get(STORAGE_KEYS.POPUP_HEIGHT).then(result => {
  const stored = result[STORAGE_KEYS.POPUP_HEIGHT];
  if (typeof stored === 'number' && stored >= POPUP_MIN_HEIGHT && stored <= POPUP_MAX_HEIGHT) {
    document.body.style.height = `${stored}px`;
  }
});
initResizeGrabber();

// Init
loadAndApplySettings().then(() => fetchAndRenderStats());
initSpotifyFilterChips();
loadActiveTabInfo();
fetchCurrentState();
fetchPendingEntries();

updateInterval = setInterval(() => {
  tickTimerDisplay();
  fetchCurrentState();
}, 1000);
const pendingInterval = setInterval(fetchPendingEntries, 5000);
const statsInterval = setInterval(fetchAndRenderStats, 60000);

window.addEventListener('pagehide', () => {
  if (updateInterval) {
    clearInterval(updateInterval);
  }
  clearInterval(pendingInterval);
  clearInterval(statsInterval);
  flushErrors();
});
