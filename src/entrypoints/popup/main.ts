// JP343 Extension - Popup UI

import { STORAGE_KEYS, activityAllowsPassive, EMPTY_DAILY_GOALS } from '../../types';
import type { TrackingSession, PendingEntry, BlockedChannel, WhitelistedChannel, ExtensionSettings, SpotifyContentType, AttentionPreference, DailyGoals } from '../../types';
import { formatDurationMs, formatGoalMinutes, isValidImageUrl } from '../../lib/format-utils';
import { initThemeToggle, applyColorTheme } from '../../lib/theme';
import { reportError, flushErrors } from '../../lib/error-reporter';
import { renderPendingList } from './pending-list';
import { createSyncIssues } from './sync-issues';
import { createTodayLive, type LiveDisplay } from './today-live';
import { createPlayerCard } from './player-card';
import { PLATFORM_ICONS } from '../../lib/platform-labels';
import { sameChannel } from '../../lib/channel-identity';
import { computeActivityGoalRows } from '../../lib/activity-goals';
import { createGoalBar } from './goal-bar';
import { createManualTrack } from './manual-track';
import { initTitleEdit } from './title-edit';
import { createStatsBar, renderWeekBars } from './stats-bar';
import { initResizeGrabber } from './resize-grabber';

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
  attentionRow: document.getElementById('attentionRow') as HTMLElement,
  btnAttentionAuto: document.getElementById('btnAttentionAuto') as HTMLButtonElement,
  btnAttentionActive: document.getElementById('btnAttentionActive') as HTMLButtonElement,
  btnAttentionPassive: document.getElementById('btnAttentionPassive') as HTMLButtonElement,
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
  musicSkippedSection: document.getElementById('musicSkippedSection') as HTMLElement,
  musicSkippedTitle: document.getElementById('musicSkippedTitle') as HTMLElement,
  btnMusicSkippedSettings: document.getElementById('btnMusicSkippedSettings') as HTMLButtonElement,
  attentionModeBanner: document.getElementById('attentionModeBanner') as HTMLElement,
  attentionModeText: document.getElementById('attentionModeText') as HTMLElement,
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

let currentSession: TrackingSession | null = null;
let updateInterval: ReturnType<typeof setInterval> | null = null;
let isEnabled = true;
let blockedChannels: BlockedChannel[] = [];
let whitelistedChannels: WhitelistedChannel[] = [];
let hideNonJapanese = false;
let trackJapaneseOnly = false;
let currentChannelId: string | null = null;
let lastSkippedChannel: { channelId: string; channelName: string; channelUrl: string | null; platform: string } | null = null;
let toastTimeout: ReturnType<typeof setTimeout> | null = null;
let fetchSeq = 0;
let isFetchingState = false;
let baseDurationMs = 0;
let baseTimestamp = 0;
let sessionTicking = false;
let lastDisplayedSecond = -1;
const playerCard = createPlayerCard(document.getElementById('playerSession') as HTMLElement);

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
let _popupShowAttention = true;
let popupDailyGoals: DailyGoals = EMPTY_DAILY_GOALS;
let popupAttentionPref: AttentionPreference = 'auto';
let popupSkippedMusic: { videoId: string | null; title: string } | null = null;

const goalBar = createGoalBar({
  getGoalMinutes: () => _popupGoalMinutes,
  getStretchEnabled: () => _popupStretchEnabled
});

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
      popupDailyGoals = settings.dailyGoals ?? EMPTY_DAILY_GOALS;
      whitelistedChannels = settings.whitelistedChannels || [];
      hideNonJapanese = settings.hideNonJapanese ?? false;
      trackJapaneseOnly = settings.trackJapaneseOnly ?? true;
      updateJpFilterDisplay(hideNonJapanese);
      applyColorTheme(settings.colorTheme ?? 'magenta');
      const attnChanged = _popupShowAttention !== (settings.showAttentionUi ?? true);
      _popupShowAttention = settings.showAttentionUi ?? true;
      if (attnChanged) void fetchPendingEntries();
      popupAttentionPref = settings.attentionPreference ?? 'auto';
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
  const onSpotify = currentSession?.platform === 'spotify' || /open\.spotify\.com/.test(manualTrack.activeTabInfo()?.url || '');
  section.style.display = onSpotify ? 'flex' : 'none';
  if (!onSpotify) return;
  const types = settings.spotifyContentTypes || ['podcast', 'audiobook'];
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
      let types = settings.spotifyContentTypes || ['podcast', 'audiobook'];
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

function initCollapsible(headerId: string, bodyId: string, arrowId: string, cardId: string): void {
  const header = document.getElementById(headerId);
  const body = document.getElementById(bodyId);
  const arrow = document.getElementById(arrowId);
  if (!header || !body || !arrow) return;
  let collapsed = false;
  browser.storage.local.get(STORAGE_KEYS.COLLAPSED_CARDS).then(result => {
    const ids: string[] = result[STORAGE_KEYS.COLLAPSED_CARDS] || [];
    if (ids.includes(cardId)) {
      collapsed = true;
      body.style.display = 'none';
      arrow.style.transform = 'rotate(-90deg)';
    }
  });
  header.addEventListener('click', () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : '';
    arrow.style.transform = collapsed ? 'rotate(-90deg)' : '';
    browser.storage.local.get(STORAGE_KEYS.COLLAPSED_CARDS).then(result => {
      const current: string[] = result[STORAGE_KEYS.COLLAPSED_CARDS] || [];
      const updated = collapsed
        ? [...current.filter(id => id !== cardId), cardId]
        : current.filter(id => id !== cardId);
      browser.storage.local.set({ [STORAGE_KEYS.COLLAPSED_CARDS]: updated });
    });
  });
}

const manualTrack = createManualTrack({
  elements,
  playerCard,
  getCurrentSession: () => currentSession,
  loadAndApplySettings,
  fetchCurrentState,
  showToast
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

function storedChannels<T extends { channelId: string; channelUrl: string | null }>(list: T[], channelId: string, channelUrl: string | null): T[] {
  return list.filter(c => sameChannel(c, { channelId, channelUrl }));
}

function currentChannelUrl(): string | null {
  return currentSession?.channelUrl || lastSkippedChannel?.channelUrl || null;
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
      && storedChannels(whitelistedChannels, session.channelId, session.channelUrl).length > 0;

    elements.btnBlockChannel.style.display = allowed ? 'none' : '';
    if (!allowed) {
      const blocked = storedChannels(blockedChannels, session.channelId, session.channelUrl).length > 0;
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
    const blocked = storedChannels(blockedChannels, skippedChannel.channelId, skippedChannel.channelUrl).length > 0;
    if (blocked) {
      elements.btnBlockChannel.style.display = '';
      elements.btnBlockChannel.textContent = 'Blocked';
      elements.btnBlockChannel.classList.add('blocked');
      elements.btnAllowChannel.style.display = 'none';
    } else {
      elements.btnBlockChannel.style.display = 'none';
      elements.btnAllowChannel.style.display = '';
      const allowed = storedChannels(whitelistedChannels, skippedChannel.channelId, skippedChannel.channelUrl).length > 0;
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
    whitelistedChannels = whitelistedChannels.filter(c => !sameChannel(c, channel));
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
  const channelUrl = currentChannelUrl();
  const channel: WhitelistedChannel = {
    channelId: currentChannelId,
    channelName: channelName,
    channelUrl: channelUrl,
    whitelistedAt: new Date().toISOString()
  };
  try {
    await browser.runtime.sendMessage({ type: 'WHITELIST_CHANNEL', channel });
    whitelistedChannels.push(channel);
    blockedChannels = blockedChannels.filter(c => !sameChannel(c, channel));
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
  const stored = storedChannels(blockedChannels, currentChannelId, currentChannelUrl());
  if (stored.length === 0) {
    await blockChannel();
    return;
  }
  for (const entry of stored) await unblockChannel(entry.channelId);
});

elements.btnAllowChannel.addEventListener('click', async () => {
  if (!currentChannelId) return;
  const stored = storedChannels(whitelistedChannels, currentChannelId, currentChannelUrl());
  if (stored.length === 0) {
    await allowChannel();
    return;
  }
  for (const entry of stored) await unallowChannel(entry.channelId);
});

initTitleEdit({ elements, getCurrentSession: () => currentSession });

function updateStatus(session: TrackingSession | null, isAd: boolean): void {
  if (isAd) {
    elements.statusDot.className = 'status-dot ad';
    elements.statusText.textContent = 'Ad';
  } else if (!session) {
    const header = playerCard.headerStatus();
    elements.statusDot.className = header?.className ?? 'status-dot';
    elements.statusText.textContent = header?.text ?? 'Idle';
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
    elements.noSession.style.display = playerCard.visible() ? 'none' : 'block';
    elements.activeSession.style.display = 'none';
    const hint = document.getElementById('noSessionHint');
    if (hint && !manualTrack.activeTabInfo()) hint.textContent = playerCard.placeholderHint() ?? 'Visit a supported streaming site to start tracking';
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
    elements.platformIcon.textContent = PLATFORM_ICONS[session.platform] || '⏵';
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
  const manualPageSession = session.platform === 'generic' && !session.videoId?.startsWith('cs_');
  elements.btnPause.style.display = manualPageSession ? '' : 'none';
  updateAttentionRow(session);
}

function updateAttentionRow(session: TrackingSession): void {
  if ((!_popupShowAttention && popupAttentionPref === 'auto') || !activityAllowsPassive(session.activityType)) {
    elements.attentionRow.style.display = 'none';
    return;
  }
  elements.attentionRow.style.display = 'flex';
  const ov = session.attentionOverride;
  elements.btnAttentionAuto.classList.toggle('active', ov === undefined);
  elements.btnAttentionActive.classList.toggle('active', ov === 'active');
  elements.btnAttentionPassive.classList.toggle('active', ov === 'passive');
}

function updateStatusBanners(session: TrackingSession | null): void {
  const showMusicSkipped = !session && !!popupSkippedMusic;
  elements.musicSkippedSection.style.display = showMusicSkipped ? 'block' : 'none';
  if (showMusicSkipped && popupSkippedMusic) {
    elements.musicSkippedTitle.textContent = popupSkippedMusic.title;
  }

  const chipsVisible = !!session && activityAllowsPassive(session.activityType)
    && (_popupShowAttention || popupAttentionPref !== 'auto');
  const showMode = popupAttentionPref !== 'auto' && !chipsVisible;
  elements.attentionModeBanner.style.display = showMode ? 'block' : 'none';
  if (showMode) {
    elements.attentionModeText.textContent = popupAttentionPref === 'passive'
      ? 'Passive mode on'
      : 'Active mode on';
  }
}

function updatePendingDisplay(entries: PendingEntry[]): void {
  elements.pendingSection.style.display = entries.length > 0 ? 'flex' : 'none';
}


const syncIssues = createSyncIssues(document.getElementById('syncIssues')!, () => _popupDayStartHour);
async function fetchPendingEntries(): Promise<void> {
  void syncIssues.refresh();
  try {
    const response = await browser.runtime.sendMessage({ type: 'GET_PENDING_ENTRIES' });

    if (response.success && response.data?.entries) {
      renderPendingList(response.data.entries, {
        listEl: elements.pendingList,
        platformIcons: PLATFORM_ICONS,
        getDayStartHour: () => _popupDayStartHour,
        showAttention: _popupShowAttention,
        onEntriesChanged: updatePendingDisplay
      });
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
      const { session, durationMs, isAd, skippedChannel, skippedMusic, player } = response.data;
      lastSkippedChannel = skippedChannel || null;
      popupSkippedMusic = skippedMusic || null;

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
      todayLive.setSession(currentSession ? {
        id: currentSession.id,
        startTime: currentSession.startTime,
        measuredMs: newDurationMs,
        activityType: currentSession.activityType,
        attention: currentSession.attention,
        attentionOverride: currentSession.attentionOverride
      } : null);
      playerCard.update(player ?? null, !!session);
      todayLive.setPlayerSession(playerCard.liveInput());
      updateStatus(session, isAd);
      updateSessionDisplay(session, isAd);
      tickTimerDisplay();
      updateChannelDisplay(session, skippedChannel);
      updateStatusBanners(session);
      manualTrack.updateDisplay();
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

async function setSessionAttention(attention: AttentionPreference): Promise<void> {
  if (!currentSession) return;

  try {
    const response = await browser.runtime.sendMessage({ type: 'SET_SESSION_ATTENTION', attention });
    if (response.success) {
      popupAttentionPref = attention;
      await fetchCurrentState();
    } else {
      log('[JP343 Popup] Failed to set attention:', response.error);
    }
  } catch (error) {
    log('[JP343 Popup] Error:', error);
  }
}

elements.btnAttentionAuto.addEventListener('click', () => setSessionAttention('auto'));
elements.btnAttentionActive.addEventListener('click', () => setSessionAttention('active'));
elements.btnAttentionPassive.addEventListener('click', () => setSessionAttention('passive'));

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

elements.btnMusicSkippedSettings.addEventListener('click', async () => {
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

function applyLiveDisplay(d: LiveDisplay): void {
  elements.statWeek.textContent = formatGoalMinutes(d.weekMinutes);
  elements.statToday.textContent = formatGoalMinutes(d.todayMinutes);
  goalBar.render(
    d.todayMinutes,
    computeActivityGoalRows(popupDailyGoals, d.byActivity, d.activeMinutes, _popupShowAttention)
  );
  renderWeekBars(d.dailyMinutes, _popupDayStartHour);
}

const todayLive = createTodayLive({
  getDayStartHour: () => _popupDayStartHour,
  onNeedRefresh: () => { void fetchAndRenderStats(); },
  onDisplay: applyLiveDisplay
});

const { fetchAndRenderStats } = createStatsBar({ statStreak: elements.statStreak, todayLive });

// Theme Toggle
initThemeToggle('themeTogglePopup');

initCollapsible('pendingHeader', 'pendingList', 'pendingCollapseArrow', 'popup-sessions');

initResizeGrabber(elements.resizeGrabber);

// Init
loadAndApplySettings().then(() => fetchAndRenderStats());
initSpotifyFilterChips();
manualTrack.loadActiveTabInfo();
fetchCurrentState();
fetchPendingEntries();

updateInterval = setInterval(() => {
  tickTimerDisplay();
  playerCard.tick();
  fetchCurrentState();
}, 1000);
const pendingInterval = setInterval(fetchPendingEntries, 5000);
const statsInterval = setInterval(fetchAndRenderStats, 60000);

function onCachedStatsChanged(
  changes: Record<string, Browser.storage.StorageChange>,
  areaName: string
): void {
  if (areaName !== 'local') return;
  if (!(STORAGE_KEYS.CACHED_SERVER_STATS in changes) && !(STORAGE_KEYS.STATS in changes)) return;
  fetchAndRenderStats();
}
browser.storage.onChanged.addListener(onCachedStatsChanged);

window.addEventListener('pagehide', () => {
  browser.storage.onChanged.removeListener(onCachedStatsChanged);
  if (updateInterval) {
    clearInterval(updateInterval);
  }
  clearInterval(pendingInterval);
  clearInterval(statsInterval);
  flushErrors();
});
