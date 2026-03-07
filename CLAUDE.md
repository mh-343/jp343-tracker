# CLAUDE.md — JP343 Extension

Guidance for Claude Code when working with the JP343 Chrome/Firefox Extension.

## Project Overview

**JP343 Streaming Tracker** ist eine Browser-Extension die Watch-Time auf YouTube, Netflix, Crunchyroll und beliebigen Seiten (Manual Tracking) trackt. Sessions werden lokal gespeichert und mit JP343.com synchronisiert.

**Tech Stack:** TypeScript, WXT Framework (Vite-basiert), Chrome MV3 / Firefox MV2

## Build & Dev

```bash
npx wxt                    # Dev (Chrome)
npx wxt -b firefox         # Dev (Firefox)
npx wxt build              # Production Build (Chrome)
npx wxt build -b firefox   # Production Build (Firefox)
npx wxt zip                # ZIP fuer Chrome Web Store
npx wxt zip -b firefox     # ZIP fuer Firefox AMO
```

Output: `dist/chrome-mv3/` bzw. `dist/firefox-mv2/`

## File Size Limits

Extension-Entrypoints sind groesser als Theme-Dateien, weil WXT eine Datei pro Entrypoint erwartet.

| Typ | Soft Limit | Hard Limit | Beispiele |
|-----|-----------|------------|-----------|
| Content Scripts (plattform-spezifisch) | 1000 | 1400 | youtube, netflix, crunchyroll |
| Background / Popup | 700 | 1000 | background.ts, popup/main.ts |
| Utility / Bridge | 500 | 800 | jp343-bridge, shared modules |

Bei Hard-Limit-Ueberschreitung: Logik in importierte Module auslagern.

## Key Files

| Datei | Zweck |
|-------|-------|
| `src/entrypoints/background.ts` | Service Worker, Session-Management, Message-Handling |
| `src/entrypoints/popup/main.ts` | Popup UI Logik |
| `src/entrypoints/popup/index.html` | Popup HTML + CSS |
| `src/entrypoints/youtube.content/` | YouTube Video-Detection + Ad-Erkennung |
| `src/entrypoints/netflix.content/` | Netflix Video-Detection |
| `src/entrypoints/crunchyroll.content/` | Crunchyroll Video-Detection |
| `src/entrypoints/jp343-bridge.content/` | Kommunikation Extension <-> JP343 Website |
| `src/types.ts` | Shared TypeScript Types |
| `wxt.config.ts` | WXT/Manifest Konfiguration, Version |

## Conventions

| Aspect | Convention |
|--------|------------|
| Kommentare | Deutsch |
| UI Text | Englisch |
| Debug Logging | `log()` via `DEBUG_MODE` Flag (nie `console.log/error/warn` direkt) |
| Version | In `wxt.config.ts` UND `package.json` synchron halten |
| Store Submission | Chrome: `npx wxt zip`, Firefox: `npx wxt zip -b firefox` |

## Critical Rules

1. **Kein console.log/error/warn direkt** — immer `log()` nutzen (wird in Production zu No-Op)
2. **Version synchron** — `wxt.config.ts` und `package.json` muessen gleiche Version haben
3. **Kein eigener Update-Checker** — Chrome/Firefox Stores machen Auto-Updates nativ
4. **CSP beachten** — Content Security Policy in popup/index.html, kein inline JS
5. **XSS-Schutz** — URLs validieren (`isValidImageUrl()`), HTML escapen (`escapeHtml()`)
6. **YouTube Ads** — Watch-Time waehrend Ads wird NICHT gezaehlt
7. **Min. 1 Minute** — Sessions unter 60 Sekunden werden nicht gespeichert
