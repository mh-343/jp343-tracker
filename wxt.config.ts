import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  outDir: 'dist',

  // mokuro host stays optional-only
  hooks: {
    'build:manifestGenerated'(wxt, manifest) {
      const MOKURO = '*://reader.mokuro.app/*';
      const keep = (p: string): boolean => p !== MOKURO;
      if (manifest.host_permissions) {
        manifest.host_permissions = manifest.host_permissions.filter(keep);
      }
      if (Array.isArray(manifest.permissions)) {
        manifest.permissions = manifest.permissions.filter(keep);
      }
      const inScripts = (manifest.content_scripts ?? []).some(
        cs => (cs.matches ?? []).some(m => m.includes('reader.mokuro.app'))
      );
      const inRequired = (manifest.host_permissions ?? []).includes(MOKURO)
        || (Array.isArray(manifest.permissions) && manifest.permissions.includes(MOKURO));
      if (inScripts || inRequired) {
        throw new Error('reader.mokuro.app must stay optional-only; would auto-disable on update');
      }
    }
  },

  manifest: ({ manifestVersion }) => ({
    name: 'jp343 Track Your Japanese Immersion',
    version: '2.10.0',
    description: 'Track your Japanese immersion automatically. Built-in dashboard with heatmap, streaks and session history.',

    browser_specific_settings: {
      gecko: {
        id: 'tracker@jp343.com',
        strict_min_version: '140.0',
        data_collection_permissions: {
          required: ['browsingActivity', 'websiteActivity'],
          optional: ['technicalAndInteraction']
        }
      },
      gecko_android: {
        strict_min_version: '128.0'
      }
    },

    permissions: [
      'storage',
      'unlimitedStorage',
      'tabs',
      'alarms',
      'contextMenus',
      'notifications',
      ...(manifestVersion === 3 ? ['scripting'] : [])
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
      '*://*.nijapanese.com/*',
      '*://*.nihongo-jikan.com/*',
      '*://open.spotify.com/*',
      '*://*.twitch.tv/*',
      '*://app.asbplayer.dev/*',
      '*://jp343.com/*',
      '*://*.jp343.com/*',
      ...(process.env.NODE_ENV !== 'production' ? [
        '*://localhost/*',
        '*://127.0.0.1/*'
      ] : [])
    ],

    // requested at runtime
    ...(manifestVersion === 3
      ? { optional_host_permissions: ['http://127.0.0.1:8765/*', '*://reader.mokuro.app/*'] }
      : { optional_permissions: ['http://127.0.0.1:8765/*', '*://reader.mokuro.app/*'] }),

    icons: {
      16: 'icon/icon-16.png',
      32: 'icon/icon-32.png',
      48: 'icon/icon-48.png',
      128: 'icon/icon-128.png'
    },

    content_security_policy: {
      extension_pages: "script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: blob: data:; connect-src 'self' https://jp343.com http://127.0.0.1:8765; object-src 'self'"
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
      },
      {
        resources: ['inject-yt-original-title.js'],
        matches: ['*://*.youtube.com/*']
      },
      {
        resources: ['inject-yt-innertube-title.js'],
        matches: ['*://*.youtube.com/*']
      },
      {
        resources: ['inject-yt-captions.js'],
        matches: ['*://*.youtube.com/*']
      },
      {
        resources: ['inject-twitch-meta.js'],
        matches: ['*://*.twitch.tv/*']
      }
    ]
  }),

  browser: 'chrome'
});
