import type { ExtensionSettings } from '../../types';

const trackJpCheckbox = document.getElementById('trackJpCheckbox') as HTMLInputElement;
const btnCreateAccount = document.getElementById('btnCreateAccount') as HTMLElement;
const btnMaybeLater = document.getElementById('btnMaybeLater') as HTMLElement;

async function init(): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage({ type: 'GET_SETTINGS' });
    if (response.success && response.data?.settings) {
      const settings = response.data.settings as ExtensionSettings;
      trackJpCheckbox.checked = settings.trackJapaneseOnly ?? false;
    }
  } catch { /* first load, defaults are fine */ }

  trackJpCheckbox.addEventListener('change', async () => {
    try {
      const res = await browser.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (res.success && res.data?.settings) {
        const s = res.data.settings as ExtensionSettings;
        s.trackJapaneseOnly = trackJpCheckbox.checked;
        await browser.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: s });
      }
    } catch { /* SW not ready */ }
  });

  btnCreateAccount.addEventListener('click', () => {
    browser.tabs.create({ url: browser.runtime.getURL('/dashboard.html') });
  });

  btnMaybeLater.addEventListener('click', () => {
    window.close();
  });
}

init();
