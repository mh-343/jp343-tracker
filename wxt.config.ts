import { defineConfig } from 'wxt';

// Siehe: https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  outDir: 'dist',

  manifest: {
    name: 'JP343 Streaming Tracker',
    version: '1.0.0',
    description: 'Track your Japanese immersion time on streaming platforms',

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
      '*://localhost/*',
      '*://127.0.0.1/*'
    ],

  },

  browser: 'chrome'
});
