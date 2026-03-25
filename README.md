# jp343 Immersion Tracker

Browser extension that automatically tracks your Japanese immersion time on streaming platforms.

## Supported Platforms

- YouTube
- Netflix
- Crunchyroll
- Amazon Prime Video
- Disney+
- CI Japanese

## Features

- **Automatic tracking** on all supported platforms
- **Ad exclusion** across YouTube, Netflix, Prime Video, Disney+ and Crunchyroll
- **Manual tracking** on any website with one click
- **Built-in dashboard** with heatmap, streaks, session history, and monthly overview
- **Channel/title blocking** to exclude specific content from tracking
- **Title editing** during or after tracking sessions
- **Optional account sync** to [jp343.com](https://jp343.com) for cross-device stats
- **Works offline** with local storage, syncs when connected

## Installation

### Chrome / Edge

1. Download the latest release ZIP from [Releases](https://github.com/mh-343/jp343-extension/releases)
2. Extract to a folder
3. Open `chrome://extensions`, enable **Developer mode**
4. Click **Load unpacked** and select the extracted folder

### Firefox

1. Download the Firefox ZIP from [Releases](https://github.com/mh-343/jp343-extension/releases)
2. Open `about:debugging` > **This Firefox** > **Load Temporary Add-on**
3. Select `manifest.json` from the extracted folder

## Privacy

- All data stays in your browser. Nothing is sent anywhere unless you create an account.
- No third-party data sharing, no analytics
- Extension only activates on supported streaming sites
- Account is optional, only needed for cross-device sync

## Development

Built with [WXT](https://wxt.dev/) and TypeScript.

```bash
npm install
npm run dev          # Chrome, hot reload
npm run dev:firefox  # Firefox, hot reload
npm run build        # Production build (Chrome)
npm run build:firefox
```

## License

GPL-3.0. See [LICENSE](LICENSE).
