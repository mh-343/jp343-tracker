// =============================================================================
// JP343 Extension - Popup UI Logik
// =============================================================================

import type { TrackingSession, Platform, PendingEntry, BlockedChannel, ExtensionSettings, ActiveTabInfo } from '../../types';

const DEBUG_MODE = import.meta.env.DEV;
const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};

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
  pendingList: document.getElementById('pendingList') as HTMLElement,
  toggleEnabled: document.getElementById('toggleEnabled') as HTMLButtonElement,
  toggleLabel: document.getElementById('toggleLabel') as HTMLElement,
  sessionCard: document.getElementById('sessionCard') as HTMLElement,
  channelSection: document.getElementById('channelSection') as HTMLElement,
  currentChannelName: document.getElementById('currentChannelName') as HTMLElement,
  btnBlockChannel: document.getElementById('btnBlockChannel') as HTMLButtonElement,
  blockedCountBadge: document.getElementById('blockedCountBadge') as HTMLElement,
  blockedCountNumber: document.getElementById('blockedCountNumber') as HTMLElement,
  btnToggleBlockedList: document.getElementById('btnToggleBlockedList') as HTMLButtonElement,
  blockedListContainer: document.getElementById('blockedListContainer') as HTMLElement,
  blockedListSearch: document.getElementById('blockedListSearch') as HTMLElement,
  blockedSearchInput: document.getElementById('blockedSearchInput') as HTMLInputElement,
  blockedList: document.getElementById('blockedList') as HTMLElement,
  btnEditTitle: document.getElementById('btnEditTitle') as HTMLButtonElement,
  // Manual Tracking
  manualTrackMode: document.getElementById('manualTrackMode') as HTMLElement,
  currentDomain: document.getElementById('currentDomain') as HTMLElement,
  manualTitle: document.getElementById('manualTitle') as HTMLInputElement,
  btnStartManual: document.getElementById('btnStartManual') as HTMLButtonElement,
  // Toast
  toast: document.getElementById('toast') as HTMLElement,
  // Stats Bar
  statWeek: document.getElementById('statWeek') as HTMLElement,
  statToday: document.getElementById('statToday') as HTMLElement,
  statStreak: document.getElementById('statStreak') as HTMLElement,
  btnResetStats: document.getElementById('btnResetStats') as HTMLButtonElement
};

// Duration mit Sekunden-Praezision formatieren
function formatDuration(minutes: number): string {
  const totalSec = Math.round(minutes * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m === 0) return `${s}s`;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

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
let isBlockedListExpanded = false;

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
  elements.toggleLabel.textContent = enabled ? 'ON' : 'OFF';
  elements.toggleLabel.classList.toggle('on', enabled);
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
    log('[JP343 Popup] Fehler beim Laden der Settings:', error);
  }
}

// ==========================================================================
// MANUAL TRACKING
// ==========================================================================

// Tab-Info laden fuer Manual Tracking
async function loadActiveTabInfo(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({ type: 'GET_ACTIVE_TAB_INFO' });
    if (response.success && response.data) {
      activeTabInfo = response.data as ActiveTabInfo;
      updateManualTrackDisplay();
    }
  } catch (error) {
    log('[JP343 Popup] Fehler beim Laden der Tab-Info:', error);
  }
}

// Manual Track Anzeige aktualisieren
function updateManualTrackDisplay(): void {
  if (!activeTabInfo) {
    elements.manualTrackMode.style.display = 'none';
    return;
  }

  // Nur anzeigen wenn KEINE Session aktiv UND KEINE Streaming-Seite
  const shouldShowManual = !currentSession && !activeTabInfo.isStreamingSite;

  if (shouldShowManual) {
    elements.noSession.style.display = 'none';
    elements.manualTrackMode.style.display = 'block';
    elements.currentDomain.textContent = activeTabInfo.domain;
    elements.manualTitle.value = activeTabInfo.title;
    elements.manualTitle.placeholder = activeTabInfo.title;
  } else {
    elements.manualTrackMode.style.display = 'none';
    // noSession nur anzeigen wenn keine Session
    if (!currentSession) {
      elements.noSession.style.display = 'block';
      // Streaming-Seite ohne aktive Session -> Hinweis anpassen
      const noSessionTitle = document.getElementById('noSessionTitle');
      const noSessionHint = document.getElementById('noSessionHint');
      if (activeTabInfo.isStreamingSite && noSessionTitle && noSessionHint) {
        noSessionTitle.textContent = 'Waiting for playback';
        noSessionHint.textContent = 'Start a video to auto-track';
      } else if (noSessionTitle && noSessionHint) {
        noSessionTitle.textContent = 'No active session';
        noSessionHint.textContent = 'Visit YouTube, Netflix or Crunchyroll to start tracking';
      }
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
      log('[JP343 Popup] Fehler beim Starten:', response.error);
    }
  } catch (error) {
    log('[JP343 Popup] Fehler:', error);
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
    log('[JP343 Popup] Fehler beim Toggle:', error);
  }
});

// ==========================================================================
// CHANNEL BLOCKING
// ==========================================================================

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
    // Channel-Name und Block-Button anzeigen
    (elements.currentChannelName.parentElement as HTMLElement).style.display = '';
    elements.btnBlockChannel.style.display = '';

    // Button-Status aktualisieren
    const blocked = isChannelBlocked(session.channelId);
    elements.btnBlockChannel.textContent = blocked ? 'Blocked' : 'Block';
    elements.btnBlockChannel.classList.toggle('blocked', blocked);
  } else {
    currentChannelId = null;
    // Channel-Section auch ohne Session anzeigen, wenn blockierte Kanaele existieren
    elements.channelSection.style.display = blockedChannels.length > 0 ? 'block' : 'none';
    // Channel-Name und Block-Button ausblenden wenn keine Session
    (elements.currentChannelName.parentElement as HTMLElement).style.display = 'none';
    elements.btnBlockChannel.style.display = 'none';
  }

  // Badge + Chevron Sichtbarkeit
  const hasBlocked = blockedChannels.length > 0;
  elements.blockedCountBadge.style.display = hasBlocked ? 'inline' : 'none';
  elements.blockedCountNumber.textContent = String(blockedChannels.length);
  elements.btnToggleBlockedList.style.display = hasBlocked ? 'inline-block' : 'none';

  // Liste zuklappen wenn leer
  if (!hasBlocked) {
    isBlockedListExpanded = false;
    elements.blockedListContainer.style.display = 'none';
    elements.btnToggleBlockedList.classList.remove('expanded');
  }
}

// Blocked-Liste rendern (innerhalb der Channel-Section)
function renderBlockedList(filterText = ''): void {
  // Badge-Count aktualisieren
  elements.blockedCountNumber.textContent = String(blockedChannels.length);
  const hasBlocked = blockedChannels.length > 0;
  elements.blockedCountBadge.style.display = hasBlocked ? 'inline' : 'none';
  elements.btnToggleBlockedList.style.display = hasBlocked ? 'inline-block' : 'none';

  // Suchfeld nur bei >= 5 Eintraegen anzeigen
  elements.blockedListSearch.style.display = blockedChannels.length >= 5 ? 'block' : 'none';

  // Liste zuklappen wenn leer
  if (!hasBlocked) {
    isBlockedListExpanded = false;
    elements.blockedListContainer.style.display = 'none';
    elements.btnToggleBlockedList.classList.remove('expanded');
  }

  // Gefilterte Kanaele
  const filtered = filterText
    ? blockedChannels.filter(c => c.channelName.toLowerCase().includes(filterText.toLowerCase()))
    : blockedChannels;

  elements.blockedList.innerHTML = filtered.map(channel => `
    <div class="blocked-item" data-id="${escapeHtml(channel.channelId)}">
      <span class="blocked-item-name">${escapeHtml(channel.channelName)}</span>
      <button class="btn-unblock" data-id="${escapeHtml(channel.channelId)}">Unblock</button>
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
    log('[JP343 Popup] Kanal blockiert:', channel.channelName);
  } catch (error) {
    log('[JP343 Popup] Fehler beim Blockieren:', error);
  }
}

// Kanal entblockieren
async function unblockChannel(channelId: string): Promise<void> {
  try {
    await browser.runtime.sendMessage({ type: 'UNBLOCK_CHANNEL', channelId });
    blockedChannels = blockedChannels.filter(c => c.channelId !== channelId);
    updateChannelDisplay(currentSession);
    renderBlockedList();
    log('[JP343 Popup] Kanal entblockiert:', channelId);
  } catch (error) {
    log('[JP343 Popup] Fehler beim Entblockieren:', error);
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

// Chevron/Badge Click → Toggle Blocked-Liste
function toggleBlockedList(): void {
  isBlockedListExpanded = !isBlockedListExpanded;
  elements.blockedListContainer.style.display = isBlockedListExpanded ? 'block' : 'none';
  elements.btnToggleBlockedList.classList.toggle('expanded', isBlockedListExpanded);
  // Suchfeld leeren beim Zuklappen
  if (!isBlockedListExpanded) {
    elements.blockedSearchInput.value = '';
    renderBlockedList();
  }
}

elements.btnToggleBlockedList.addEventListener('click', toggleBlockedList);
elements.blockedCountBadge.addEventListener('click', toggleBlockedList);

// Search Input → Filter Blocked-Liste
elements.blockedSearchInput.addEventListener('input', () => {
  renderBlockedList(elements.blockedSearchInput.value);
});

// ==========================================================================
// TITLE EDITING
// ==========================================================================

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
        log('[JP343 Popup] Titel aktualisiert:', newTitle);
      } catch (error) {
        log('[JP343 Popup] Fehler beim Aktualisieren des Titels:', error);
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
  // Ad-Check ZUERST: Bei Pre-Roll Ads gibt es noch keine Session
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

  // Thumbnail (Fix 1: XSS-sicher via createElement statt innerHTML)
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

  // Details
  elements.sessionTitle.textContent = session.title;
  // Bei 'generic' die echte Domain aus der URL zeigen
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

// Session-Liste anzeigen (kein Sync-Status sichtbar)
function updatePendingDisplay(entries: PendingEntry[]): void {
  // Eingeloggt: nur unsynced Entries zeigen (synced = auf Server, Popup braucht sie nicht)
  // Nicht eingeloggt: alle zeigen
  const hasAuth = entries.some(e => e.synced);
  const visible = hasAuth
    ? entries.filter(e => !e.synced)
    : entries;

  elements.pendingSection.style.display = visible.length > 0 ? 'block' : 'none';
}

// Status-Badge fuer Entry
function getStatusBadge(entry: PendingEntry): string {
  if (entry.synced) {
    return '<span class="pending-entry-status synced">✓</span>';
  }
  if (entry.lastSyncError) {
    return `<span class="pending-entry-status failed" title="${escapeHtml(entry.lastSyncError)}">!</span>`;
  }
  return '<span class="pending-entry-status pending">●</span>';
}

// Status-Badge fuer gruppierte Entries
function getGroupStatusBadge(group: GroupedEntry): string {
  if (group.allSynced) {
    return '<span class="pending-entry-status synced">✓</span>';
  }
  if (group.hasError) {
    return '<span class="pending-entry-status failed" title="Sync error">!</span>';
  }
  return '<span class="pending-entry-status pending">●</span>';
}

// Gruppierter Entry Typ (fuer Anzeige im Popup)
interface GroupedEntry {
  primary: PendingEntry;      // Erster/neuester Entry als Referenz
  entries: PendingEntry[];    // Alle Entries in der Gruppe
  entryIds: string[];         // Alle Entry-IDs in der Gruppe
  totalMinutes: number;       // Aufsummierte Zeit
  sessionCount: number;       // Anzahl Sessions
  allSynced: boolean;         // Alle Entries synced?
  hasError: boolean;          // Mindestens ein Fehler?
}

// Entries nach Video gruppieren (URL als Key)
function groupEntriesByVideo(entries: PendingEntry[]): GroupedEntry[] {
  const groups = new Map<string, GroupedEntry>();

  for (const entry of entries) {
    // project_id ist konsistenter als URL (gleiche Video-ID = gleiche project_id)
    // Fallback auf URL fuer manuell getrackte Entries ohne project_id
    const key = entry.project_id || entry.url;

    if (groups.has(key)) {
      const group = groups.get(key)!;
      group.entries.push(entry);
      group.entryIds.push(entry.id);
      group.totalMinutes += entry.duration_min;
      group.sessionCount++;
      if (!entry.synced) group.allSynced = false;
      if (entry.lastSyncError) group.hasError = true;
      // primary = neuester Entry (fuer Sortierung und Anzeige)
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

  // Einzelne Sessions innerhalb jeder Gruppe: neueste zuerst
  const result = Array.from(groups.values());
  for (const group of result) {
    group.entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    group.entryIds = group.entries.map(e => e.id);
  }
  return result;
}

// Pending Entries Liste rendern (gruppiert nach Video)
function renderPendingList(entries: PendingEntry[]): void {
  pendingEntries = entries;

  // Display aktualisieren (zeigt Original-Counts)
  updatePendingDisplay(entries);

  if (entries.length === 0) {
    elements.pendingList.innerHTML = '';
    return;
  }

  // Expanded-State merken vor Re-Render
  const expandedGroups = new Set<string>();
  elements.pendingList.querySelectorAll('.session-details-list').forEach(el => {
    if ((el as HTMLElement).style.display !== 'none') {
      expandedGroups.add((el as HTMLElement).dataset.group || '');
    }
  });

  // Entries nach Video gruppieren, neueste zuerst, max 5 Gruppen
  const grouped = groupEntriesByVideo(entries);
  const sorted = [...grouped]
    .sort((a, b) => new Date(b.primary.date).getTime() - new Date(a.primary.date).getTime())
    .slice(0, 5);

  elements.pendingList.innerHTML = sorted.map((group, groupIndex) => {
    const entry = group.primary;
    const hasMultipleSessions = group.sessionCount > 1;

    // Session-Details fuer aufklappbare Liste rendern
    const sessionDetails = group.entries.map(e => `
      <div class="session-detail" data-id="${escapeHtml(e.id)}">
        <span class="session-detail-date">${formatSessionDate(e.date)}</span>
        <span class="session-detail-duration">${formatDuration(e.duration_min)}</span>
        <button class="session-detail-delete" data-id="${escapeHtml(e.id)}" title="Delete this session">×</button>
      </div>
    `).join('');

    // Fix 1: URL-Validierung und Escaping fuer Thumbnails/URLs
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
            ${entry.platform} · <strong>${formatDuration(group.totalMinutes)}</strong>
            ${hasMultipleSessions ? `<button class="pending-entry-expand" data-group="${groupIndex}" title="Show ${group.sessionCount} sessions">(${group.sessionCount}×) ▼</button>` : ''}
            ${entry.url && !group.allSynced ? (
              currentSession && isSameVideo(currentSession.url, entry.url)
                ? `<span class="pending-entry-tracking">● Tracking</span>`
                : `<button class="pending-entry-continue" data-url="${safeUrl}" title="Continue watching">Continue ▶</button>`
            ) : ''}
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

  // Delete-Buttons Event Listener (loescht alle Entries der Gruppe)
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

  // Edit-Buttons Event Listener (nur fuer unsynced Entries)
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

  // Continue-Buttons - Video oeffnen und Popup schliessen
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

  // Expand-Buttons - Session-Details aufklappen
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

  // Session-Detail Delete-Buttons - einzelne Session loeschen
  elements.pendingList.querySelectorAll('.session-detail-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const entryId = (btn as HTMLElement).dataset.id;
      if (entryId) {
        await deleteEntry(entryId);
      }
    });
  });

  // Expanded-State wiederherstellen nach Re-Render
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

// Pending Entry Titel bearbeiten
function startPendingEntryTitleEdit(entryId: string): void {
  const editBtn = elements.pendingList.querySelector(`.pending-entry-edit[data-id="${entryId}"]`) as HTMLElement;
  // Title span is sibling of edit button in the same .pending-entry-title-row
  const titleSpan = editBtn?.parentElement?.querySelector('.pending-entry-title') as HTMLElement;
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
      // Alle Entry-IDs der Gruppe aktualisieren
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
        log('[JP343 Popup] Pending Entry Titel aktualisiert:', newTitle, `(${allIds.length} Eintraege)`);
      } catch (error) {
        log('[JP343 Popup] Fehler beim Aktualisieren des Titels:', error);
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

// URL-Validierung: Nur https:// URLs erlauben (Fix 1)
function isValidImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// Datum fuer Session-Details formatieren
function formatSessionDate(isoDate: string): string {
  try {
    const date = new Date(isoDate);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

// Pruefen ob zwei URLs das gleiche Video sind (ignoriert Query-Parameter-Unterschiede)
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

    // Netflix: Pfad vergleichen (enthält Title-ID)
    if (u1.hostname.includes('netflix') && u2.hostname.includes('netflix')) {
      return u1.pathname === u2.pathname;
    }

    // Fallback: Hostname + Pathname vergleichen
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
    log('[JP343 Popup] Fehler beim Loeschen:', error);
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
    log('[JP343 Popup] Fehler beim Laden der Entries:', error);
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
      // Pending display wird in renderPendingList aktualisiert
    }
  } catch (error) {
    log('[JP343 Popup] Fehler beim Laden:', error);
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
    log('[JP343 Popup] Fehler:', error);
  }
});

// Stop Button Handler
elements.btnStop.addEventListener('click', async () => {
  try {
    const response = await browser.runtime.sendMessage({ type: 'STOP_SESSION' });

    if (response.success) {
      await fetchCurrentState();
      await fetchPendingEntries();

      // Feedback wenn Session zu kurz war
      if (response.saved === false) {
        showToast('Session too short (min. 1 minute)', 'warning');
      }
    }
  } catch (error) {
    log('[JP343 Popup] Fehler:', error);
  }
});

// Dashboard Button Handler
document.getElementById('btnDashboard')?.addEventListener('click', () => {
  const dashboardUrl = browser.runtime.getURL('dashboard.html');
  browser.tabs.create({ url: dashboardUrl });
  window.close();
});

// (Sync Now + Clear Synced entfernt — Auto-Sync handled alles)

// =============================================================================
// STATS BAR
// =============================================================================

// Stat-Werte fuer Dashboard-Darstellung (ohne Sekunden, mit Stunden)
function formatStatDuration(minutes: number): string {
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded}m`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// Wochenbalken (Mo-So) unter dem Stats-Bar rendern
function renderWeekBars(dailyMinutes: Record<string, number>): void {
  const container = document.getElementById('weekBars');
  if (!container) return;

  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=So, 1=Mo...
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const todayStr = now.toISOString().split('T')[0];

  // ISO-Datums-Strings fuer Mo-So aufbauen
  const days: { date: string; label: string }[] = [];
  const dayLabels = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + mondayOffset + i);
    days.push({ date: d.toISOString().split('T')[0], label: dayLabels[i] });
  }

  // Maximalwert der Woche bestimmen (fuer relative Balkenhoehe)
  const maxVal = Math.max(1, ...days.map(d => dailyMinutes[d.date] || 0));

  // DOM-Aufbau ohne innerHTML
  container.replaceChildren();
  for (const { date, label } of days) {
    const minutes = dailyMinutes[date] || 0;
    const isToday = date === todayStr;
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
      if (rawDailyMinutes) {
        renderWeekBars(rawDailyMinutes);
      }
    }
  } catch (error) {
    log('[JP343 Popup] Stats fetch failed:', error);
  }
}

// Stats Reset Handler
elements.btnResetStats.addEventListener('click', async () => {
  if (!confirm('Reset extension stats? This only affects the stats shown here, not your synced data on JP343.')) {
    return;
  }
  try {
    await browser.runtime.sendMessage({ type: 'RESET_STATS' });
    await fetchAndRenderStats();
  } catch (error) {
    log('[JP343 Popup] Stats reset failed:', error);
  }
});

// Initial laden
loadAndApplySettings();
loadActiveTabInfo();
fetchCurrentState();
fetchPendingEntries();
fetchAndRenderStats();

// Periodisches Update (alle Sekunde fuer Timer, alle 5 Sekunden fuer Liste, alle 60s fuer Stats)
updateInterval = setInterval(fetchCurrentState, 1000);
const pendingInterval = setInterval(fetchPendingEntries, 5000);
const statsInterval = setInterval(fetchAndRenderStats, 60000);

// Cleanup beim Schliessen (Fix 15)
window.addEventListener('unload', () => {
  if (updateInterval) {
    clearInterval(updateInterval);
  }
  clearInterval(pendingInterval);
  clearInterval(statsInterval);
});
