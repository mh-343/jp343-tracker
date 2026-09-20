import type { MpchcState, MpchcStatus } from '../../lib/mpchc';
import { MPCHC_ORIGINS } from '../../lib/mpchc';
import { createToggleRow } from './settings-helpers';

const STATUS_TEXT: Record<MpchcStatus, string> = {
  off: 'Off. Enable to track what you play in MPC-HC.',
  idle: 'Connected. Play a video in MPC-HC to start tracking.',
  playing: 'Connected · Tracking playback.',
  paused: 'Connected · Paused. No time is being counted.',
  unreachable: 'Open MPC-HC and enable its Web Interface. Connection checks continue automatically.',
  error: 'Could not read the player status. Check the Web Interface settings, then try again.',
  permission_needed: 'Allow local player access by switching tracking on again.',
  unsupported: 'MPC-HC tracking is available on desktop only.',
};

interface MpchcResponse { success: boolean; data?: MpchcState; error?: string; }

export function buildMpchcPanel(container: HTMLElement): void {
  const section = document.createElement('div');
  section.className = 'settings-section';
  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'MPC-HC';
  section.appendChild(title);

  const help = document.createElement('div');
  help.className = 'settings-description';
  help.textContent = 'In MPC-HC, open Options → Player → Web Interface and turn on “Listen on port” (13579). Keep your browser open while you watch.';
  section.appendChild(help);
  const status = document.createElement('div');
  status.className = 'settings-row-desc';
  status.setAttribute('role', 'status');
  status.textContent = 'Checking…';
  let enabled = false;
  let toggle: HTMLButtonElement | null = null;
  const test = document.createElement('button');
  test.type = 'button';
  test.className = 'export-btn';
  test.textContent = 'Check connection';
  test.disabled = true;

  function render(response: MpchcResponse): void {
    if (!response.success || !response.data) throw new Error('Could not read settings');
    enabled = response.data.enabled;
    toggle?.classList.toggle('enabled', enabled);
    toggle?.setAttribute('aria-checked', String(enabled));
    status.textContent = STATUS_TEXT[response.data.status];
    test.disabled = !enabled;
  }

  const row = createToggleRow('Track MPC-HC playback', 'Read playback status from your local player.', false, async value => {
    if (toggle) toggle.disabled = true;
    test.disabled = true;
    try {
      if (value && !(await browser.permissions.request({ origins: MPCHC_ORIGINS }))) {
        throw new Error('Allow local player access to turn tracking on.');
      }
      status.textContent = value ? 'Connecting…' : 'Saving…';
      render(await browser.runtime.sendMessage({ type: 'SET_MPCHC_ENABLED', enabled: value }) as MpchcResponse);
    } catch (error) {
      toggle?.classList.toggle('enabled', enabled);
      toggle?.setAttribute('aria-checked', String(enabled));
      status.textContent = error instanceof Error ? error.message : 'Could not update player settings. Try again.';
    } finally {
      if (toggle) toggle.disabled = false;
      test.disabled = !enabled;
    }
  });
  toggle = row.querySelector<HTMLButtonElement>('.settings-toggle');
  section.appendChild(row);
  section.appendChild(status);
  test.addEventListener('click', async () => {
    test.disabled = true;
    if (toggle) toggle.disabled = true;
    status.textContent = 'Connecting…';
    try {
      render(await browser.runtime.sendMessage({ type: 'MPCHC_PROBE' }) as MpchcResponse);
    } catch {
      status.textContent = 'Could not check the player. Try again.';
    } finally {
      test.disabled = !enabled;
      if (toggle) toggle.disabled = false;
    }
  });
  section.appendChild(test);
  container.appendChild(section);
  if (toggle) toggle.disabled = true;
  void browser.runtime.sendMessage({ type: 'GET_MPCHC_STATUS' }).then(response => render(response as MpchcResponse)).catch(() => {
    status.textContent = 'Could not read player settings. Try switching tracking on again.';
  }).finally(() => { if (toggle) toggle.disabled = false; });

  // live status while the panel is on screen
  let probing = false;
  const refresh = setInterval(async () => {
    if (!section.isConnected) { clearInterval(refresh); return; }
    if (!enabled || probing || toggle?.disabled || section.offsetParent === null || document.visibilityState !== 'visible') return;
    probing = true;
    try {
      render(await browser.runtime.sendMessage({ type: 'MPCHC_PROBE' }) as MpchcResponse);
    } catch { /* keep the last status */ } finally {
      probing = false;
    }
  }, 5000);
  window.addEventListener('pagehide', () => clearInterval(refresh));
}
