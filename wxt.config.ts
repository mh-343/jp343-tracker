import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  outDir: 'dist',

  manifest: {
    name: 'jp343 Track Your Japanese Immersion',
    version: '2.3.3',
    description: 'Track your Japanese immersion automatically. Built-in dashboard with heatmap, streaks and session history.',

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
      'alarms'
    ],

    host_permissions: [
      '*://*.youtube.com/*',
      '*://*.netflix.com/*',
      '*://*.crunchyroll.com/*',
      '*://*.primevideo.com/*',
      '*://*.amazon.com/*',
      '*://*.amazon.de/*',
      '*://*.amazon.co.jp/*',
      '*://*.amazon.com.br/*',
      '*://*.disneyplus.com/*',
      '*://*.cijapanese.com/*',
      '*://open.spotify.com/*',
      '*://jp343.com/*',
      '*://*.jp343.com/*',
      ...(process.env.NODE_ENV !== 'production' ? [
        '*://localhost/*',
        '*://127.0.0.1/*'
      ] : [])
    ],

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
