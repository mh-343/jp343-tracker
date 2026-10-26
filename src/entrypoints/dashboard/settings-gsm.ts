import type { GsmState, GsmStatus } from '../../lib/gsm/state';
import { GSM_ORIGINS } from '../../lib/gsm/state';
import { buildGsmImportPanel } from './settings-gsm-import';
import { createToggleRow } from './settings-helpers';

const LOCAL_NOTE = 'Saved in this browser. Log in on jp343.com to keep it in your account.';

const STATUS_TEXT: Record<GsmStatus, string> = {
  off: 'Off. Switch on to sync your reading time from GameSentenceMiner.',
  connecting: 'Connecting…',
  ok: 'Connected.',
  local: `Connected. ${LOCAL_NOTE}`,
  unreachable: 'Start GameSentenceMiner on this computer. Checks continue automatically.',
  unsupported: 'This GameSentenceMiner version is not supported yet. Nothing is synced.',
  no_games: 'Connected. GameSentenceMiner has no games yet.',
  too_many_games: 'GameSentenceMiner has more than 2000 games. Syncing is paused.',
  signed_out: 'Log in on jp343.com again to sync your GameSentenceMiner time. It still counts in this browser.',
  server_unavailable: 'jp343.com could not be reached. Syncing retries automatically.',
  call_rejected: 'jp343.com did not accept the last sync. Syncing retries automatically.',
  permission_needed: 'Allow local access to keep syncing.',
  desktop_only: 'GameSentenceMiner syncing is available on desktop only.',
};

interface GsmResponse { success: boolean; data?: GsmState; error?: string; }

function statusText(state: GsmState): string {
  if ((state.status !== 'ok' && state.status !== 'local') || !state.lastHot) return STATUS_TEXT[state.status];
  const time = new Date(state.lastHot).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `Connected · Last sync ${time}.${state.status === 'local' ? ` ${LOCAL_NOTE}` : ''}`;
}

function noteText(state: GsmState): string {
  if (!state.enabled) return '';
  const notes: string[] = [];
  if (state.rejectedCount > 0) notes.push(`${state.rejectedCount} ${state.rejectedCount === 1 ? 'session' : 'sessions'} could not be synced.`);
  if (state.oversizedDays > 0) notes.push(`${state.oversizedDays} ${state.oversizedDays === 1 ? 'day has' : 'days have'} too many sessions to sync.`);
  const excluded = Object.values(state.lbExcluded).reduce((sum, n) => sum + n, 0);
  if (excluded > 0) {
    notes.push(`${excluded} ${excluded === 1 ? 'session' : 'sessions'} not counted on the leaderboard (not Japanese). The time still counts fully in your account.`);
  }
  return notes.join(' ');
}

export function buildGsmPanel(container: HTMLElement): void {
  const section = document.createElement('div');
  section.className = 'settings-section';
  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'GameSentenceMiner';
  section.appendChild(title);

  const help = document.createElement('div');
  help.className = 'settings-description';
  help.textContent = 'Syncs your reading time from GameSentenceMiner (GSM). GSM must run on this computer, on port 7275 or 55000 ("GSM Unified Port" in its settings). Without an account the time stays in this browser; with a jp343.com account it is also saved to your account. Time counts from the moment you switch this on; older GSM history can be imported below. Pauses do not count, so times can be lower than what older GSM versions show.';
  section.appendChild(help);
  const status = document.createElement('div');
  status.className = 'settings-row-desc';
  status.setAttribute('role', 'status');
  status.textContent = 'Checking…';
  const note = document.createElement('div');
  note.className = 'settings-row-desc';
  let enabled = false;
  let toggle: HTMLButtonElement | null = null;
  const syncNow = document.createElement('button');
  syncNow.type = 'button';
  syncNow.className = 'export-btn';
  syncNow.textContent = 'Sync now';
  syncNow.disabled = true;
  const allow = document.createElement('button');
  allow.type = 'button';
  allow.className = 'export-btn';
  allow.textContent = 'Allow access';
  allow.hidden = true;
  const allowHint = document.createElement('div');
  allowHint.className = 'settings-row-desc';
  allowHint.textContent = 'If GameSentenceMiner runs on port 55000, allow access.';
  allowHint.hidden = true;

  // keeps enabledAt, unlike switching off and on
  async function updateAllow(state: GsmState): Promise<void> {
    const stuck = state.enabled && ['permission_needed', 'unreachable', 'unsupported'].includes(state.status);
    const missing = stuck && !(await browser.permissions.contains({ origins: GSM_ORIGINS }));
    allow.hidden = !missing;
    allowHint.hidden = !missing || state.status === 'permission_needed';
  }

  function render(response: GsmResponse): void {
    if (!response.success || !response.data) throw new Error('Could not read settings');
    enabled = response.data.enabled;
    toggle?.classList.toggle('enabled', enabled);
    toggle?.setAttribute('aria-checked', String(enabled));
    status.textContent = statusText(response.data);
    note.textContent = noteText(response.data);
    syncNow.disabled = !enabled;
    void updateAllow(response.data).catch(() => {});
  }

  const row = createToggleRow('Sync GameSentenceMiner reading time', 'Reads your reading sessions from GSM on this computer.', false, async value => {
    if (toggle) toggle.disabled = true;
    syncNow.disabled = true;
    try {
      if (value && !(await browser.permissions.request({ origins: GSM_ORIGINS }))) {
        throw new Error('Allow local access to switch syncing on.');
      }
      status.textContent = value ? 'Connecting…' : 'Saving…';
      render(await browser.runtime.sendMessage({ type: 'SET_GSM_ENABLED', enabled: value }) as GsmResponse);
    } catch (error) {
      toggle?.classList.toggle('enabled', enabled);
      toggle?.setAttribute('aria-checked', String(enabled));
      status.textContent = error instanceof Error ? error.message : 'Could not update GSM settings. Try again.';
    } finally {
      if (toggle) toggle.disabled = false;
      syncNow.disabled = !enabled;
    }
  });
  toggle = row.querySelector<HTMLButtonElement>('.settings-toggle');
  section.appendChild(row);
  section.appendChild(status);
  section.appendChild(note);
  syncNow.addEventListener('click', async () => {
    syncNow.disabled = true;
    if (toggle) toggle.disabled = true;
    status.textContent = 'Syncing…';
    try {
      render(await browser.runtime.sendMessage({ type: 'GSM_SYNC_NOW' }) as GsmResponse);
    } catch {
      status.textContent = 'Could not sync. Try again.';
    } finally {
      syncNow.disabled = !enabled;
      if (toggle) toggle.disabled = false;
    }
  });
  section.appendChild(syncNow);
  allow.addEventListener('click', async () => {
    allow.disabled = true;
    try {
      if (!(await browser.permissions.request({ origins: GSM_ORIGINS }))) {
        status.textContent = STATUS_TEXT.permission_needed;
        return;
      }
      status.textContent = 'Connecting…';
      render(await browser.runtime.sendMessage({ type: 'GSM_SYNC_NOW' }) as GsmResponse);
    } catch {
      status.textContent = 'Could not sync. Try again.';
    } finally {
      allow.disabled = false;
    }
  });
  section.appendChild(allow);
  section.appendChild(allowHint);
  buildGsmImportPanel(section);
  container.appendChild(section);
  if (toggle) toggle.disabled = true;
  void browser.runtime.sendMessage({ type: 'GET_GSM_STATUS' }).then(response => render(response as GsmResponse)).catch(() => {
    status.textContent = 'Could not read GSM settings. Try switching syncing on again.';
  }).finally(() => { if (toggle) toggle.disabled = false; });

  // status only, never triggers a sync
  let reading = false;
  const refresh = setInterval(async () => {
    if (!section.isConnected) { clearInterval(refresh); return; }
    if (!enabled || reading || toggle?.disabled || section.offsetParent === null || document.visibilityState !== 'visible') return;
    reading = true;
    try {
      render(await browser.runtime.sendMessage({ type: 'GET_GSM_STATUS' }) as GsmResponse);
    } catch { /* keep the last status */ } finally {
      reading = false;
    }
  }, 5000);
  window.addEventListener('pagehide', () => clearInterval(refresh));
}
