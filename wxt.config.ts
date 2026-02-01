import { defineConfig } from 'wxt';

// WXT Konfiguration fuer JP343 Streaming Time Tracker
// Siehe: https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  outDir: 'dist',

  manifest: {
    name: 'JP343 Streaming Tracker',
    version: '1.0.0',
    description: 'Track your Japanese immersion time on streaming platforms',

    permissions: [
      'storage',      // chrome.storage.local fuer pending entries
      'tabs',         // Tab-Info fuer aktive Sessions
      'alarms'        // Periodische Sync-Checks
    ],

    host_permissions: [
      '*://*.youtube.com/*',
      '*://*.netflix.com/*',
      '*://*.crunchyroll.com/*',
      // JP343 Domains - hier deine Domain eintragen
      '*://jp343.com/*',
      '*://*.jp343.com/*',
      '*://localhost/*',
      '*://127.0.0.1/*'
    ],

    // Icons werden automatisch aus public/icon/ generiert
    // Siehe: https://wxt.dev/guide/essentials/assets.html#extension-icons
  },

  // Chrome als Haupt-Target, Firefox wird automatisch unterstuetzt
  browser: 'chrome'
});
