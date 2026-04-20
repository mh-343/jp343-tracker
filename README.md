# jp343 Immersion Tracker

Browser extension that automatically tracks your Japanese immersion time on streaming platforms.

## Install

- [Chrome Web Store](https://chromewebstore.google.com/detail/jp343-track-your-japanese/ogjnhhmcfdkpmllikfmjdlhjepadeigl)
- [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/jp343-immersion-tracker/)

## Supported Platforms

- YouTube
- Netflix
- Crunchyroll
- Amazon Prime Video
- Disney+
- Spotify
- CI Japanese

## Features

- **Automatic tracking** on all supported platforms
- **Ad exclusion** across YouTube, Netflix, Prime Video, Disney+ and Crunchyroll
- **Manual tracking** on any website with one click
- **Built-in dashboard** with heatmap, streaks, session history, and monthly overview
- **Channel/title blocking** to exclude specific content from tracking
- **Title editing** during or after tracking sessions
- **Optional account sync** to [jp343.com](https://jp343.com) for cross-device stats
- **Works offline** with local storage, no account required

## Permissions

- **Storage** for saving sessions and settings locally
- **Tabs** for the manual tracking feature (reads the active tab's title and URL when you start a session)
- **Host access** limited to the 6 supported platforms and jp343.com

## Privacy

- All data stays in your browser unless you create an account on jp343.com
- No third-party data sharing, no analytics
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

## Community

- Same-day session merge — idea by [ラッキー](https://github.com/quopquai)

## License

GPL-3.0. See [LICENSE](LICENSE).
