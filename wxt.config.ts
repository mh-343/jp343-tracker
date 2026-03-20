import { defineConfig } from 'wxt';

// Siehe: https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  outDir: 'dist',

  manifest: {
    name: 'jp343 Track Your Japanese Immersion',
    version: '2.0.1',
    description: 'Auto-tracks YouTube, Netflix & Crunchyroll. No account needed. Built-in dashboard with heatmap, streaks, and session history.',

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
      'storage',
      'tabs',
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

  browser: 'chrome'
});
