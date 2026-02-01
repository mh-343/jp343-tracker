# JP343 Streaming Tracker Extension

Browser extension to track Japanese immersion time on streaming platforms (YouTube, Netflix).

## Features

- Automatic video playback detection
- Time tracking with ad exclusion
- Sync with JP343 website
- Visual status indicator on extension icon

## Development

```bash
# Install dependencies
npm install

# Development mode (with hot reload)
npm run dev

# Build for production
npm run build
```

## Installation

### Manual Installation (Developer Mode)

1. Run `npm run build`
2. Open `chrome://extensions` in Chrome
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the `dist/chrome-mv3` folder

## Tech Stack

- [WXT](https://wxt.dev/) - Browser Extension Framework
- TypeScript
- Manifest V3

## License

Private - All rights reserved
