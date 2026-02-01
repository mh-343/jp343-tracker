// JP343 Extension - Popup UI Logik

import type { TrackingSession, Platform, PendingEntry } from '../../types';

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
  btnClear: document.getElementById('btnClear') as HTMLButtonElement
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

// Initial laden
fetchCurrentState();
fetchPendingEntries();

updateInterval = setInterval(fetchCurrentState, 1000);
setInterval(fetchPendingEntries, 5000);

// Cleanup beim Schliessen
window.addEventListener('unload', () => {
  if (updateInterval) {
    clearInterval(updateInterval);
  }
});
