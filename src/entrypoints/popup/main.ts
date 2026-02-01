// JP343 Extension - Popup UI Logik

import type { TrackingSession, Platform, PendingEntry, BlockedChannel, ExtensionSettings } from '../../types';

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
  blockedList: document.getElementById('blockedList') as HTMLElement
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
  elements.sessionPlatform.textContent = session.platform + '.com';

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

// Pending Entries Liste rendern
function renderPendingList(entries: PendingEntry[]): void {
  pendingEntries = entries;

  // Display aktualisieren
  updatePendingDisplay(entries);

  if (entries.length === 0) {
    elements.pendingList.innerHTML = '';
    return;
  }

  // Sortieren: Unsynced zuerst, dann synced
  const sorted = [...entries].sort((a, b) => {
    if (a.synced === b.synced) return 0;
    return a.synced ? 1 : -1;
  });

  elements.pendingList.innerHTML = sorted.map(entry => `
    <div class="pending-entry ${entry.synced ? 'synced' : ''}" data-id="${entry.id}">
      ${entry.thumbnail
        ? `<img src="${entry.thumbnail}" class="pending-entry-thumb" alt="">`
        : `<div class="pending-entry-thumb" style="display:flex;align-items:center;justify-content:center;font-size:12px;">${platformIcons[entry.platform] || '⏵'}</div>`
      }
      <div class="pending-entry-info">
        <div class="pending-entry-title">${escapeHtml(entry.project)}</div>
        <div class="pending-entry-meta">${entry.platform} · ${entry.duration_min}m</div>
      </div>
      ${getStatusBadge(entry)}
      <button class="pending-entry-delete" data-id="${entry.id}" title="Delete">×</button>
    </div>
  `).join('');

  // Delete-Buttons Event Listener
  elements.pendingList.querySelectorAll('.pending-entry-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const entryId = (btn as HTMLElement).dataset.id;
      if (entryId) {
        await deleteEntry(entryId);
      }
    });
  });
}

// HTML escapen
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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
