# JP343 Streaming Tracker

Browser extension to automatically track your Japanese immersion time on streaming platforms.

## Download

| Browser | Download | Status |
|---------|----------|--------|
| **Chrome/Edge** | [Download v1.2.0](https://github.com/mh-343/jp343-extension/releases/download/v1.2.0/jp343-extension-v1.2.0-chrome.zip) | ✅ Ready |
| **Firefox** | [Download v1.2.0](https://github.com/mh-343/jp343-extension/releases/download/v1.2.0/jp343-extension-v1.2.0-firefox.zip) | ✅ Ready |

## Features

- **Automatic Tracking** - Detects video playback on YouTube and Netflix
- **Manual Tracking** - Track time on ANY website with one click
- **Ad Exclusion** - Ads are not counted towards your immersion time
- **Title Editing** - Edit titles during or after tracking sessions
- **Channel Blocking** - Block specific YouTube channels from tracking
- **Sync with JP343** - Tracked time syncs to your JP343 account
- **Visual Status** - Extension icon shows recording status
- **Offline Support** - Entries are saved locally until sync

## Installation

### Chrome

1. **Download** the Chrome ZIP from the table above
2. **Extract** to a folder on your computer
3. Open `chrome://extensions` in Chrome
4. Enable **Developer mode** (toggle in top-right corner)
5. Click **Load unpacked**
6. Select the extracted folder
7. **Pin the extension** - Click the puzzle icon and pin "JP343 Streaming Tracker"

### Firefox

1. **Download** the Firefox ZIP from the table above
2. **Extract** to a folder on your computer
3. Open `about:debugging` in Firefox
4. Click **This Firefox** in the left sidebar
5. Click **Load Temporary Add-on**
6. Select `manifest.json` from the extracted folder

> **Note:** Firefox temporary add-ons are removed when Firefox closes. For permanent installation, Firefox Add-ons Store submission is planned.

## Usage

1. **Watch videos** on YouTube or Netflix as usual
2. **Check the icon** - See the status badge for feedback
3. **Visit JP343** - Your time syncs automatically when you visit jp343.com

### Icon Status

| Badge | Meaning |
|-------|---------|
| ● (green) | Recording |
| ❚❚ (orange) | Paused |
| AD (gray) | Ad playing (not tracking) |
| Number (purple) | Pending entries to sync |

## Supported Platforms

- ✅ YouTube
- ✅ Netflix
- 🔜 Crunchyroll (coming soon)
- 🔜 Amazon Prime Video (planned)

## Privacy

- No data is sent to third parties
- All data stays between your browser and JP343
- Extension only activates on supported streaming sites
- No account required (optional for cloud sync)

## Development

```bash
# Install dependencies
npm install

# Development mode (Chrome, hot reload)
npm run dev

# Development mode (Firefox)
npm run dev:firefox

# Production build (Chrome)
npm run build

# Production build (Firefox)
npm run build:firefox

# Create release ZIPs (both browsers)
npm run release
```

## Updating

1. Download the new version
2. Extract to the same folder (overwrite)
3. **Chrome:** Go to `chrome://extensions` and click the refresh icon
4. **Firefox:** Reload the temporary add-on in `about:debugging`

## Support

Questions or issues? Visit [jp343.com/extension](https://jp343.com/extension)

---

Made with ♥ for the Japanese learning community
