import type { ExtensionSettings } from '../../types';
import { STORAGE_KEYS, DEFAULT_SETTINGS } from '../../types';

export async function getSettings(): Promise<ExtensionSettings> {
  const response = await browser.runtime.sendMessage({ type: 'GET_SETTINGS' });
  if (response.success && response.data?.settings) {
    return response.data.settings as ExtensionSettings;
  }
  return { ...DEFAULT_SETTINGS };
}

export async function getFreshSettings(): Promise<ExtensionSettings> {
  const res = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(res[STORAGE_KEYS.SETTINGS] || {}) };
}

export async function updateSettings(patch: Partial<ExtensionSettings>): Promise<void> {
  const current = await getSettings();
  const updated = { ...current, ...patch };
  await browser.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: updated });
}

export function createToggleRow(
  label: string,
  description: string,
  enabled: boolean,
  onChange: (val: boolean) => Promise<void>
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'settings-row';

  const info = document.createElement('div');
  info.className = 'settings-row-info';
  const labelEl = document.createElement('div');
  labelEl.className = 'settings-row-label';
  labelEl.textContent = label;
  info.appendChild(labelEl);
  if (description) {
    const desc = document.createElement('div');
    desc.className = 'settings-row-desc';
    desc.textContent = description;
    info.appendChild(desc);
  }

  const toggle = document.createElement('button');
  toggle.className = 'settings-toggle' + (enabled ? ' enabled' : '');
  toggle.type = 'button';
  toggle.addEventListener('click', async () => {
    const newVal = !toggle.classList.contains('enabled');
    toggle.classList.toggle('enabled', newVal);
    await onChange(newVal);
  });

  row.appendChild(info);
  row.appendChild(toggle);
  return row;
}

export function showStatus(container: HTMLElement, message: string, type: 'success' | 'error'): void {
  let el = container.querySelector('.settings-status') as HTMLElement | null;
  if (!el) {
    el = document.createElement('div');
    el.className = 'settings-status';
    container.appendChild(el);
  }
  el.className = 'settings-status ' + type;
  el.textContent = message;
  if (type === 'success') {
    setTimeout(() => { el!.className = 'settings-status'; }, 3000);
  }
}
