import { defineConfig } from 'wxt';

// WXT Konfiguration fuer JP343 Streaming Time Tracker
// Siehe: https://wxt.dev/api/config.html
// HINWEIS (Fix 14): Firefox MV3 wird von WXT automatisch unterstuetzt.
// Wenn Firefox irgendwann volle MV3-Kompatibilitaet erhaelt (background.service_worker),
// muss hier nichts angepasst werden — WXT generiert das korrekte Manifest pro Browser.
export default defineConfig({
  srcDir: 'src',
  outDir: 'dist',

  manifest: {
    name: 'JP343 Streaming Tracker',
    version: '1.6.3',
    description: 'Track your Japanese immersion time on streaming platforms',

    // Firefox Add-on ID (fuer AMO Store Submission)
    browser_specific_settings: {
      gecko: {
        id: 'tracker@jp343.com',
        strict_min_version: '109.0',
        data_collection_permissions: {
          required: ['browsingActivity', 'websiteActivity'],
          optional: []
        }
      }
    },

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
      // localhost nur im Dev-Build (Fix 12)
      ...(process.env.NODE_ENV !== 'production' ? [
        '*://localhost/*',
        '*://127.0.0.1/*'
      ] : [])
    ],

    // Icon-Dateien (Anime-Maskottchen)
    icons: {
      16: 'icon/icon-16.png',
      32: 'icon/icon-32.png',
      48: 'icon/icon-48.png',
      128: 'icon/icon-128.png'
    },

    // Web accessible resources - Scripts die in Page Context injiziert werden
    web_accessible_resources: [
      {
        resources: ['inject-user-state.js'],
        matches: [
          '*://jp343.com/*',
          '*://*.jp343.com/*',
          // localhost nur im Dev-Build (Fix 12)
          ...(process.env.NODE_ENV !== 'production' ? [
            '*://localhost/*',
            '*://127.0.0.1/*'
          ] : [])
        ]
      }
    ]
  },

  // Chrome als Haupt-Target, Firefox wird automatisch unterstuetzt
  browser: 'chrome'
});
