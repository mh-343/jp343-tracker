# JP343 Streaming Tracker Extension

Browser extension to automatically track your Japanese immersion time on streaming platforms.

## Features

- **Automatic Tracking** - Detects video playback on YouTube and Netflix
- **Ad Exclusion** - Ads are not counted towards your immersion time
- **Sync with JP343** - Tracked time syncs to your JP343 account
- **Visual Status** - Extension icon shows recording status (●/❚❚/AD)
- **Offline Support** - Entries are saved locally until sync

## Installation

### Step 1: Download

Download the latest release ZIP from the [Releases page](../../releases).

### Step 2: Extract

Extract the ZIP file to a folder on your computer.

### Step 3: Load in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **Load unpacked**
4. Select the extracted folder

### Step 4: Pin the Extension

Click the puzzle icon in Chrome toolbar and pin "JP343 Streaming Tracker" for easy access.

## Usage

1. **Watch videos** on YouTube or Netflix as usual
2. **Check the icon** - Green dot (●) means recording
3. **Visit JP343** - Your time syncs automatically when you visit jp343.com

### Icon Status

| Badge | Meaning |
|-------|---------|
| ● (green) | Recording |
| ❚❚ (orange) | Paused |
| AD (gray) | Ad playing (not tracking) |
| Number (purple) | Pending entries to sync |

## Supported Platforms

- YouTube
- Netflix
- (More coming soon)

## Privacy

- No data is sent to third parties
- All data stays between your browser and JP343
- Extension only activates on supported streaming sites

## Development

```bash
# Install dependencies
npm install

# Development mode (hot reload)
npm run dev

# Production build
npm run build

# Create release ZIP
npm run release
```

## Updating

1. Download the new version
2. Extract to the same folder (overwrite)
3. Go to `chrome://extensions`
4. Click the refresh icon on the extension

## Support

Questions or issues? Visit [jp343.com](https://jp343.com)

---

Made with ♥ for the Japanese learning community
