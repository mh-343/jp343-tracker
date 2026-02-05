// JP343 Extension - Popup UI Logik

import type { TrackingSession, Platform, PendingEntry, BlockedChannel, ExtensionSettings, ActiveTabInfo } from '../../types';

// DOM Elements
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
  pendingCount: document.getElementById('pendingCount') as HTMLElement,
  pendingMinutes: document.getElementById('pendingMinutes') as HTMLElement,
  syncedCount: document.getElementById('syncedCount') as HTMLElement,
  pendingList: document.getElementById('pendingList') as HTMLElement,
  btnSync: document.getElementById('btnSync') as HTMLButtonElement,
  btnClear: document.getElementById('btnClear') as HTMLButtonElement,
  updateBanner: document.getElementById('updateBanner') as HTMLElement,
  updateVersion: document.getElementById('updateVersion') as HTMLElement,
  toggleEnabled: document.getElementById('toggleEnabled') as HTMLButtonElement,
  sessionCard: document.getElementById('sessionCard') as HTMLElement,
  channelSection: document.getElementById('channelSection') as HTMLElement,
  currentChannelName: document.getElementById('currentChannelName') as HTMLElement,
  btnBlockChannel: document.getElementById('btnBlockChannel') as HTMLButtonElement,
  blockedSection: document.getElementById('blockedSection') as HTMLElement,
  blockedList: document.getElementById('blockedList') as HTMLElement,
  btnEditTitle: document.getElementById('btnEditTitle') as HTMLButtonElement,
  // Manual Tracking
  manualTrackMode: document.getElementById('manualTrackMode') as HTMLElement,
  currentDomain: document.getElementById('currentDomain') as HTMLElement,
  manualTitle: document.getElementById('manualTitle') as HTMLInputElement,
  btnStartManual: document.getElementById('btnStartManual') as HTMLButtonElement,
  // Toast
  toast: document.getElementById('toast') as HTMLElement
};

// Platform Icons
const platformIcons: Record<Platform, string> = {
  youtube: '▶',
  netflix: 'N',
  crunchyroll: 'C',
  generic: '⏵'
};

// State
let currentSession: TrackingSession | null = null;
let isAdPlaying = false;
let updateInterval: ReturnType<typeof setInterval> | null = null;
let pendingEntries: PendingEntry[] = [];
let isEnabled = true;
let blockedChannels: BlockedChannel[] = [];
let currentChannelId: string | null = null;
let activeTabInfo: ActiveTabInfo | null = null;
let toastTimeout: ReturnType<typeof setTimeout> | null = null;

// Toast anzeigen
function showToast(message: string, type: 'warning' | 'success' = 'warning', duration = 3000): void {
  // Vorherigen Toast abbrechen
  if (toastTimeout) {
    clearTimeout(toastTimeout);
  }

  elements.toast.textContent = message;
  elements.toast.className = `toast ${type} visible`;

  toastTimeout = setTimeout(() => {
    elements.toast.classList.remove('visible');
  }, duration);
}

// Toggle-Anzeige aktualisieren
function updateToggleDisplay(enabled: boolean): void {
  isEnabled = enabled;
  if (enabled) {
    elements.toggleEnabled.classList.add('enabled');
    elements.sessionCard.classList.remove('disabled');
  } else {
    elements.toggleEnabled.classList.remove('enabled');
    elements.sessionCard.classList.add('disabled');
  }
}

// Settings laden und Toggle aktualisieren
async function loadAndApplySettings(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (response.success && response.data?.settings) {
      const settings = response.data.settings as ExtensionSettings;
      updateToggleDisplay(settings.enabled);
      blockedChannels = settings.blockedChannels || [];
      renderBlockedList();
    }
  } catch (error) {
    console.error('[JP343 Popup] Fehler beim Laden der Settings:', error);
  }
}

// MANUAL TRACKING

async function loadActiveTabInfo(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({ type: 'GET_ACTIVE_TAB_INFO' });
    if (response.success && response.data) {
      activeTabInfo = response.data as ActiveTabInfo;
      updateManualTrackDisplay();
    }
  } catch (error) {
    console.error('[JP343 Popup] Fehler beim Laden der Tab-Info:', error);
  }
}

// Manual Track Anzeige aktualisieren
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
  } else {
    elements.manualTrackMode.style.display = 'none';
    if (!currentSession) {
      elements.noSession.style.display = 'block';
    }
  }
}

// Start Manual Tracking Handler
elements.btnStartManual.addEventListener('click', async () => {
  if (!activeTabInfo) return;

  const title = elements.manualTitle.value.trim() || activeTabInfo.title;

  try {
    const response = await browser.runtime.sendMessage({
      type: 'MANUAL_TRACK_START',
      title: title,
      url: activeTabInfo.url,
      tabId: activeTabInfo.tabId
    });

    if (response.success) {
      // UI aktualisieren
      await fetchCurrentState();
    } else {
      console.error('[JP343 Popup] Fehler beim Starten:', response.error);
    }
  } catch (error) {
    console.error('[JP343 Popup] Fehler:', error);
  }
});

// Toggle Handler
elements.toggleEnabled.addEventListener('click', async () => {
  const newState = !isEnabled;
  try {
    await browser.runtime.sendMessage({ type: 'SET_ENABLED', enabled: newState });
    updateToggleDisplay(newState);
    // Status sofort aktualisieren
    await fetchCurrentState();
  } catch (error) {
    console.error('[JP343 Popup] Fehler beim Toggle:', error);
  }
});

// CHANNEL BLOCKING

// Pruefen ob Kanal blockiert ist
function isChannelBlocked(channelId: string): boolean {
  return blockedChannels.some(c => c.channelId === channelId);
}

// Channel-Anzeige aktualisieren
function updateChannelDisplay(session: TrackingSession | null): void {
  if (session && session.channelId && session.platform === 'youtube') {
    currentChannelId = session.channelId;
    elements.channelSection.style.display = 'block';
    elements.currentChannelName.textContent = session.channelName || session.channelId;

    // Button-Status aktualisieren
    const blocked = isChannelBlocked(session.channelId);
    elements.btnBlockChannel.textContent = blocked ? 'Blocked' : 'Block';
    elements.btnBlockChannel.classList.toggle('blocked', blocked);
  } else {
    currentChannelId = null;
    elements.channelSection.style.display = 'none';
  }
}

// Blocked-Liste rendern
function renderBlockedList(): void {
  if (blockedChannels.length === 0) {
    elements.blockedSection.style.display = 'none';
    return;
  }

  elements.blockedSection.style.display = 'block';
  elements.blockedList.innerHTML = blockedChannels.map(channel => `
    <div class="blocked-item" data-id="${channel.channelId}">
      <span class="blocked-item-name">${escapeHtml(channel.channelName)}</span>
      <button class="btn-unblock" data-id="${channel.channelId}">Unblock</button>
    </div>
  `).join('');

  // Unblock-Buttons Event Listener
  elements.blockedList.querySelectorAll('.btn-unblock').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const channelId = (btn as HTMLElement).dataset.id;
      if (channelId) {
        await unblockChannel(channelId);
      }
    });
  });
}

// Kanal blockieren
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
    updateChannelDisplay(currentSession);
    renderBlockedList();
    console.log('[JP343 Popup] Kanal blockiert:', channel.channelName);
  } catch (error) {
    console.error('[JP343 Popup] Fehler beim Blockieren:', error);
  }
}

// Kanal entblockieren
async function unblockChannel(channelId: string): Promise<void> {
  try {
    await browser.runtime.sendMessage({ type: 'UNBLOCK_CHANNEL', channelId });
    blockedChannels = blockedChannels.filter(c => c.channelId !== channelId);
    updateChannelDisplay(currentSession);
    renderBlockedList();
    console.log('[JP343 Popup] Kanal entblockiert:', channelId);
  } catch (error) {
    console.error('[JP343 Popup] Fehler beim Entblockieren:', error);
  }
}

// Block-Button Handler
elements.btnBlockChannel.addEventListener('click', async () => {
  if (!currentChannelId) return;

  if (isChannelBlocked(currentChannelId)) {
    await unblockChannel(currentChannelId);
  } else {
    await blockChannel();
  }
});

// TITLE EDITING

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

  // Input erstellen
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-title-input';
  input.value = currentTitle;

  // Title und Edit-Button verstecken
  elements.sessionTitle.style.display = 'none';
  elements.btnEditTitle.style.display = 'none';

  // Input einfuegen
  titleRow.insertBefore(input, elements.sessionTitle);
  input.focus();
  input.select();

  const saveEdit = async () => {
    const newTitle = input.value.trim();
    if (newTitle && newTitle !== currentTitle) {
      // Titel im Background aktualisieren
      try {
        await browser.runtime.sendMessage({
          type: 'UPDATE_SESSION_TITLE',
          title: newTitle
        });
        elements.sessionTitle.textContent = newTitle;
        console.log('[JP343 Popup] Titel aktualisiert:', newTitle);
      } catch (error) {
        console.error('[JP343 Popup] Fehler beim Aktualisieren des Titels:', error);
      }
    }

    // Aufräumen
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

// Status aktualisieren
function updateStatus(session: TrackingSession | null, isAd: boolean): void {
  if (!session) {
    elements.statusDot.className = 'status-dot';
    elements.statusText.textContent = 'Idle';
  } else if (isAd) {
    elements.statusDot.className = 'status-dot ad';
    elements.statusText.textContent = 'Ad';
  } else if (session.isPaused) {
    elements.statusDot.className = 'status-dot paused';
    elements.statusText.textContent = 'Paused';
  } else if (session.isActive) {
    elements.statusDot.className = 'status-dot recording';
    elements.statusText.textContent = 'REC';
  }
}

// Session-Anzeige aktualisieren
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

  // Thumbnail
  if (session.thumbnailUrl) {
    elements.thumbnail.innerHTML = `<img src="${session.thumbnailUrl}" class="session-thumbnail" alt="">`;
  } else {
    elements.thumbnail.className = 'session-thumbnail placeholder';
    elements.platformIcon.textContent = platformIcons[session.platform] || '⏵';
  }

  // Details
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

  // Timer
  elements.sessionTimer.textContent = duration;
  elements.sessionTimer.className = isAd ? 'session-timer ad' : 'session-timer';
  elements.adLabel.style.display = isAd ? 'block' : 'none';

  // Pause Button Text
  elements.btnPause.textContent = session.isPaused ? 'Resume' : 'Pause';
}

function updatePendingDisplay(entries: PendingEntry[]): void {
  const unsynced = entries.filter(e => !e.synced);
  const synced = entries.filter(e => e.synced);

  if (entries.length > 0) {
    elements.pendingSection.style.display = 'block';
    elements.pendingCount.textContent = String(unsynced.length);
    elements.pendingMinutes.textContent = String(unsynced.reduce((sum, e) => sum + e.duration_min, 0));
    elements.syncedCount.textContent = String(synced.length);

    elements.btnClear.style.display = synced.length > 0 ? 'inline-block' : 'none';
  } else {
    elements.pendingSection.style.display = 'none';
  }
}

function getStatusBadge(entry: PendingEntry): string {
  if (entry.synced) {
    return '<span class="pending-entry-status synced">✓</span>';
  }
  if (entry.lastSyncError) {
    return `<span class="pending-entry-status failed" title="${escapeHtml(entry.lastSyncError)}">!</span>`;
  }
  return '<span class="pending-entry-status pending">●</span>';
}

function getGroupStatusBadge(group: GroupedEntry): string {
  if (group.allSynced) {
    return '<span class="pending-entry-status synced">✓</span>';
  }
  if (group.hasError) {
    return '<span class="pending-entry-status failed" title="Sync error">!</span>';
  }
  return '<span class="pending-entry-status pending">●</span>';
}

interface GroupedEntry {
  primary: PendingEntry;      // Erster/neuester Entry als Referenz
  entries: PendingEntry[];    // Alle Entries in der Gruppe
  entryIds: string[];         // Alle Entry-IDs in der Gruppe
  totalMinutes: number;       // Aufsummierte Zeit
  sessionCount: number;       // Anzahl Sessions
  allSynced: boolean;         // Alle Entries synced?
  hasError: boolean;          // Mindestens ein Fehler?
}

function groupEntriesByVideo(entries: PendingEntry[]): GroupedEntry[] {
  const groups = new Map<string, GroupedEntry>();

  for (const entry of entries) {
    const key = entry.url || entry.project_id;

    if (groups.has(key)) {
      const group = groups.get(key)!;
      group.entries.push(entry);
      group.entryIds.push(entry.id);
      group.totalMinutes += entry.duration_min;
      group.sessionCount++;
      if (!entry.synced) group.allSynced = false;
      if (entry.lastSyncError) group.hasError = true;
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

  return Array.from(groups.values());
}

function renderPendingList(entries: PendingEntry[]): void {
  pendingEntries = entries;

  updatePendingDisplay(entries);

  if (entries.length === 0) {
    elements.pendingList.innerHTML = '';
    return;
  }

  const grouped = groupEntriesByVideo(entries);

  // Sortieren: Unsynced zuerst, dann synced
  const sorted = [...grouped].sort((a, b) => {
    if (a.allSynced === b.allSynced) return 0;
    return a.allSynced ? 1 : -1;
  });

  elements.pendingList.innerHTML = sorted.map((group, groupIndex) => {
    const entry = group.primary;
    const hasMultipleSessions = group.sessionCount > 1;

    const sessionDetails = group.entries.map(e => `
      <div class="session-detail" data-id="${e.id}">
        <span class="session-detail-date">${formatSessionDate(e.date)}</span>
        <span class="session-detail-duration">${e.duration_min}m</span>
        <span class="session-detail-status ${e.synced ? 'synced' : 'pending'}">${e.synced ? '✓' : '●'}</span>
        <button class="session-detail-delete" data-id="${e.id}" title="Delete this session">×</button>
      </div>
    `).join('');

    return `
    <div class="pending-entry-group ${group.allSynced ? 'synced' : ''}" data-group="${groupIndex}">
      <div class="pending-entry" data-ids="${group.entryIds.join(',')}" data-url="${entry.url || ''}">
        <div class="pending-entry-thumb-wrap ${entry.url ? 'clickable' : ''}" data-url="${entry.url || ''}" title="${entry.url ? 'Open video' : ''}">
          ${entry.thumbnail
            ? `<img src="${entry.thumbnail}" class="pending-entry-thumb" alt="">`
            : `<div class="pending-entry-thumb" style="display:flex;align-items:center;justify-content:center;font-size:12px;">${platformIcons[entry.platform] || '⏵'}</div>`
          }
          ${entry.url ? '<span class="pending-entry-play">▶</span>' : ''}
        </div>
        <div class="pending-entry-info">
          <div class="pending-entry-title-row">
            <span class="pending-entry-title ${entry.url ? 'clickable' : ''}" data-ids="${group.entryIds.join(',')}" data-url="${entry.url || ''}">${escapeHtml(entry.project)}</span>
            ${!group.allSynced ? `
              <button class="pending-entry-edit" data-id="${entry.id}" title="Edit title">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
                </svg>
              </button>
            ` : ''}
          </div>
          <div class="pending-entry-meta">
            ${entry.platform} · <strong>${group.totalMinutes}m</strong>
            ${hasMultipleSessions ? `<button class="pending-entry-expand" data-group="${groupIndex}" title="Show ${group.sessionCount} sessions">(${group.sessionCount}×) ▼</button>` : ''}
            ${entry.url && !group.allSynced ? (
              currentSession && isSameVideo(currentSession.url, entry.url)
                ? `<span class="pending-entry-tracking">● Tracking</span>`
                : `<button class="pending-entry-continue" data-url="${entry.url}" title="Continue watching">Continue ▶</button>`
            ) : ''}
          </div>
        </div>
        ${getGroupStatusBadge(group)}
        <button class="pending-entry-delete" data-ids="${group.entryIds.join(',')}" title="Delete all sessions">×</button>
      </div>
      ${hasMultipleSessions ? `
        <div class="session-details-list" data-group="${groupIndex}" style="display: none;">
          ${sessionDetails}
        </div>
      ` : ''}
    </div>
  `;
  }).join('');

  elements.pendingList.querySelectorAll('.pending-entry-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ids = (btn as HTMLElement).dataset.ids;
      if (ids) {
        // Alle Entries der Gruppe loeschen
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

  // Klickbare Thumbnails - Video oeffnen
  elements.pendingList.querySelectorAll('.pending-entry-thumb-wrap.clickable').forEach(thumb => {
    thumb.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = (thumb as HTMLElement).dataset.url;
      if (url) {
        browser.tabs.create({ url });
      }
    });
  });

  // Klickbare Titel - Video oeffnen
  elements.pendingList.querySelectorAll('.pending-entry-title.clickable').forEach(title => {
    title.addEventListener('click', (e) => {
      e.stopPropagation();
      const url = (title as HTMLElement).dataset.url;
      if (url) {
        browser.tabs.create({ url });
      }
    });
  });

  elements.pendingList.querySelectorAll('.pending-entry-continue').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const url = (btn as HTMLElement).dataset.url;
      if (url) {
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
}

// Pending Entry Titel bearbeiten
function startPendingEntryTitleEdit(entryId: string): void {
  const titleSpan = elements.pendingList.querySelector(`.pending-entry-title[data-id="${entryId}"]`) as HTMLElement;
  const editBtn = elements.pendingList.querySelector(`.pending-entry-edit[data-id="${entryId}"]`) as HTMLElement;
  if (!titleSpan) return;

  const titleRow = titleSpan.parentElement;
  if (!titleRow) return;

  const currentTitle = titleSpan.textContent || '';

  // Input erstellen
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'pending-entry-title-input';
  input.value = currentTitle;

  // Title und Edit-Button verstecken
  titleSpan.style.display = 'none';
  if (editBtn) editBtn.style.display = 'none';

  // Input einfuegen
  titleRow.insertBefore(input, titleSpan);
  input.focus();
  input.select();

  const saveEdit = async () => {
    const newTitle = input.value.trim();
    if (newTitle && newTitle !== currentTitle) {
      // Titel im Background aktualisieren
      try {
        await browser.runtime.sendMessage({
          type: 'UPDATE_PENDING_ENTRY_TITLE',
          entryId,
          title: newTitle
        });
        titleSpan.textContent = newTitle;
        console.log('[JP343 Popup] Pending Entry Titel aktualisiert:', newTitle);
      } catch (error) {
        console.error('[JP343 Popup] Fehler beim Aktualisieren des Titels:', error);
      }
    }

    // Aufraeumen
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

// HTML escapen
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatSessionDate(isoDate: string): string {
  try {
    const date = new Date(isoDate);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function isSameVideo(url1: string, url2: string): boolean {
  if (!url1 || !url2) return false;
  if (url1 === url2) return true;

  try {
    const u1 = new URL(url1);
    const u2 = new URL(url2);

    // YouTube: Video-ID vergleichen
    if (u1.hostname.includes('youtube') && u2.hostname.includes('youtube')) {
      const v1 = u1.searchParams.get('v');
      const v2 = u2.searchParams.get('v');
      if (v1 && v2) return v1 === v2;
    }

    if (u1.hostname.includes('netflix') && u2.hostname.includes('netflix')) {
      return u1.pathname === u2.pathname;
    }

    return u1.hostname === u2.hostname && u1.pathname === u2.pathname;
  } catch {
    return false;
  }
}

// Entry loeschen
async function deleteEntry(entryId: string): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({
      type: 'DELETE_PENDING_ENTRY',
      entryId
    });

    if (response.success) {
      // Liste aktualisieren
      await fetchPendingEntries();
      await fetchCurrentState();
    }
  } catch (error) {
    console.error('[JP343 Popup] Fehler beim Loeschen:', error);
  }
}

// Pending Entries laden
async function fetchPendingEntries(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({ type: 'GET_PENDING_ENTRIES' });

    if (response.success && response.data?.entries) {
      renderPendingList(response.data.entries);
    }
  } catch (error) {
    console.error('[JP343 Popup] Fehler beim Laden der Entries:', error);
  }
}

// Daten vom Background holen
async function fetchCurrentState(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({ type: 'GET_CURRENT_SESSION' });

    if (response.success && response.data) {
      const { session, duration, isAd } = response.data;

      currentSession = session;
      isAdPlaying = isAd;

      updateStatus(session, isAd);
      updateSessionDisplay(session, duration, isAd);
      updateChannelDisplay(session);
      updateManualTrackDisplay(); // Manual Track Anzeige aktualisieren
    }
  } catch (error) {
    console.error('[JP343 Popup] Fehler beim Laden:', error);
  }
}

// Pause/Resume Button Handler
elements.btnPause.addEventListener('click', async () => {
  if (!currentSession) return;

  const action = currentSession.isPaused ? 'RESUME_SESSION' : 'PAUSE_SESSION';

  try {
    await browser.runtime.sendMessage({ type: action });
    await fetchCurrentState();
  } catch (error) {
    console.error('[JP343 Popup] Fehler:', error);
  }
});

// Stop Button Handler
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
    console.error('[JP343 Popup] Fehler:', error);
  }
});

// Sync Button Handler
elements.btnSync.addEventListener('click', async () => {
  // JP343 Tab oeffnen
  await browser.tabs.create({ url: 'https://jp343.com' });
  window.close();
});

// Clear Synced Button Handler
elements.btnClear.addEventListener('click', async () => {
  try {
    const response = await browser.runtime.sendMessage({ type: 'CLEAR_SYNCED_ENTRIES' });

    if (response.success) {
      console.log('[JP343 Popup] Synced entries geloescht:', response.data?.removed);
      await fetchPendingEntries();
    }
  } catch (error) {
    console.error('[JP343 Popup] Fehler beim Loeschen:', error);
  }
});

function isNewerVersion(currentVer: string, newVer: string): boolean {
  const current = currentVer.replace(/^v/, '').split('.').map(Number);
  const latest = newVer.replace(/^v/, '').split('.').map(Number);

  for (let i = 0; i < Math.max(current.length, latest.length); i++) {
    const c = current[i] || 0;
    const l = latest[i] || 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

// Update-Check via GitHub Releases API
async function checkForUpdates(): Promise<void> {
  try {
    const currentVersion = browser.runtime.getManifest().version;

    // GitHub API: Letztes Release abrufen
    const response = await fetch(
      'https://api.github.com/repos/mh-343/jp343-extension/releases/latest',
      { headers: { 'Accept': 'application/vnd.github.v3+json' } }
    );

    if (!response.ok) {
      console.log('[JP343 Popup] Update-Check fehlgeschlagen:', response.status);
      return;
    }

    const release = await response.json();
    const latestVersion = release.tag_name?.replace(/^v/, '') || '';

    console.log('[JP343 Popup] Version check:', currentVersion, '→', latestVersion);

    if (latestVersion && isNewerVersion(currentVersion, latestVersion)) {
      // Update verfuegbar - Banner anzeigen
      elements.updateVersion.textContent = `v${currentVersion} → v${latestVersion}`;
      elements.updateBanner.classList.add('visible');
      console.log('[JP343 Popup] Update verfuegbar:', latestVersion);
    }
  } catch (error) {
    console.log('[JP343 Popup] Update-Check nicht moeglich');
  }
}

// Initial laden
loadAndApplySettings();
loadActiveTabInfo();
fetchCurrentState();
fetchPendingEntries();
checkForUpdates();

updateInterval = setInterval(fetchCurrentState, 1000);
setInterval(fetchPendingEntries, 5000);

// Cleanup beim Schliessen
window.addEventListener('unload', () => {
  if (updateInterval) {
    clearInterval(updateInterval);
  }
});
