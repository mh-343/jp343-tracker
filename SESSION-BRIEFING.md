# JP343 Extension v2.0 — Session Briefing

**Datum:** 2026-03-20
**Für:** Nächste Claude Code Session (nahtlose Weiterarbeit)

## Was wurde gemacht

Kompletter Relaunch der JP343 Chrome/Firefox Extension. Vorher: "Datensammler für die Website". Nachher: eigenständiges Produkt mit Dashboard, Login, Auto-Sync.

### Geänderte Dateien

**Extension (`jp343-extension/`):**
- `wxt.config.ts` — Name: "JP343 — Track Your Japanese Immersion", v2.0.0
- `package.json` — v2.0.0
- `src/types/index.ts` — `SYNC_ENTRIES_DIRECT`, `OPEN_DASHBOARD`, `DirectSyncResult`, `serverEntryId`
- `src/lib/format-utils.ts` — **NEU** — Shared utilities (formatStatDuration, formatDuration, etc.)
- `src/entrypoints/dashboard/index.html` — **NEU** — Full dashboard page (Heatmap, Stats, Sessions, Login/Register)
- `src/entrypoints/dashboard/dashboard.ts` — **NEU** — Dashboard logic (auth, server fetch, rendering)
- `src/entrypoints/background.ts` — Auto-Sync, SYNC_ENTRIES_DIRECT, PAUSE_VIDEO, auto-cleanup alarm
- `src/entrypoints/popup/index.html` — Footer redesign, Sync UI removed
- `src/entrypoints/popup/main.ts` — Sync buttons removed, Dashboard button added
- `src/entrypoints/youtube.content/index.ts` — PAUSE_VIDEO + RESUME_VIDEO handler
- `src/entrypoints/netflix.content/index.ts` — PAUSE_VIDEO + RESUME_VIDEO handler
- `src/entrypoints/crunchyroll.content/index.ts` — PAUSE_VIDEO + RESUME_VIDEO handler

**Website (`generatepress-child/`):**
- `inc/ajax/auth-handlers.php` — 4 neue Endpoints:
  - `jp343_extension_auth` — Login ohne Nonce (für Extension Service Worker)
  - `jp343_extension_register` — Registration direkt aus Extension
  - `jp343_extension_log_time` — Sync ohne Cookies (`JP343_EXTENSION_DIRECT_AUTH`)
  - `jp343_extension_nonce_refresh` — Nonce erneuern via Auth-Cookie
- `inc/ajax/time-tracking-handlers.php` — `JP343_EXTENSION_DIRECT_AUTH` Bypass für `check_ajax_referer`

**Alle Website-Änderungen sind bereits auf dem Server deployed.**

### Commits
- Extension: `1872530` (v2.0 Hauptarbeit) + `ac0fc1a` (Dashboard polish)
- Website: `50fd9e3` (Auth endpoints)

## Architektur-Entscheidungen

1. **Extension-First:** Extension ist das Primary Product, jp343.com wird optionaler Backend
2. **Sync ist unsichtbar:** Keine Dots, kein "Sync Now", kein "pending". Auto-Sync im Hintergrund.
3. **Kein Guest-Token in Extension:** Nur "Local Only" oder "Logged In". Token-System bleibt auf Website.
4. **Service Worker hat keine Cookies:** Deshalb `jp343_extension_log_time` mit `user_id` statt Nonce-Check. `JP343_EXTENSION_DIRECT_AUTH` Constant überspringt `check_ajax_referer`.
5. **Delete = Stunden weg:** Immer, auch für synced Entries.

## Bekannte Bugs / Offene Issues

### Bugs
- **Firefox Logout braucht manchmal 2 Klicks** — `isLoggingOut` Flag timing issue
- **Fresh Extension Install zeigt 0m** bis Server antwortet (selten, nur nach Neuinstall)
- **"This Month" nutzt nur lokale Daten** — Server-Endpoint `jp343_get_time_stats` gibt kein `month_seconds` zurück
- **Achievements werden bei neuem Account sofort alle vergeben** — neuer Account mit 6min Tracking bekommt 12 Achievements (100 Hours, One Year, etc.). Achievement-Logik auf Website prüfen — werden bei Account-Erstellung/Login alle auf einmal granted statt bei echtem Erreichen?
- ~~Skeleton-Loader entfernt~~ — Session-Loading Skeleton wieder eingebaut (nur bei eingeloggten Usern)
- ~~Session History Dauer gerundet~~ — Server gibt jetzt `duration_seconds` zurück, Dashboard nutzt `formatDuration()`

### UX Polish nötig
- ~~Flash: lokale Werte blitzen kurz auf bevor Server-Daten kommen~~ — bei eingeloggten Usern wird Session-Liste nur einmal gerendert (nach Server-Fetch)
- Blocked Channels sind nur lokal pro Browser (kein Sync)

## Open Tasks (priorisiert)

### P1 — Store Submission
- [ ] Firefox E2E Test abschließen
- [ ] Chrome Web Store ZIP erstellen + einreichen
- [ ] Firefox AMO ZIP erstellen + einreichen
- [ ] Store Description updaten (alter Text erwähnt "pending list", "Visit JP343.com to sync")

### P2 — Website aufräumen
- [ ] Timer aus Navigation entfernen
- [ ] Projects-Page in My Hub mergen (redirect)
- [ ] Extension-Page in Homepage mergen (redirect)
- [ ] Navigation: Home + My Hub + Account only

### P3 — Marketing
- [ ] Reddit post r/LearnJapanese
- [ ] Store Screenshots mit neuem Dashboard

### Polish
- [ ] Blocked Channels sync to DB
- [ ] Cache last server response (verhindert 0→real Flash)
- [ ] `month_seconds` zu `jp343_get_time_stats` hinzufügen
- [ ] Dashboard: `video_title` statt `project_name` wo verfügbar

## Wichtige Dateipfade

```
Extension:  C:\Users\PCUser\Documents\Jp343-git\jp343-extension\
Website:    C:\Users\PCUser\Documents\Jp343-git\jp343\app\public\wp-content\themes\generatepress-child\
Builds:     dist/chrome-mv3/ (Chrome) + dist/firefox-mv2/ (Firefox)
Plan:       .claude/plans/zany-churning-reddy.md
Memory:     .claude/projects/.../memory/ (MEMORY.md, project_extension_*.md, feedback_*.md)
```

## Gotchas aus dieser Session

- **Gotcha #19:** Service Worker + WordPress Nonce = immer ohne Cookies planen. `wp_verify_nonce` braucht Session-Token aus Cookies.
- **Gotcha #20:** `wp_ajax_nopriv_*` reicht nicht für Extension-Endpoints. IMMER auch `wp_ajax_*` registrieren.

## Competitor Context

**Mikan 見聞** (einziger direkter Konkurrent): 1.9 Sterne Chrome Web Store, YouTube-only, buggy Detection, kein Backend. JP343 ist technisch überlegen aber hat keine Distribution. Jouzu Juls (Mikan-Entwickler) hat 95K YouTube Subscribers.

Mikan-Extension Code wurde heruntergeladen und analysiert: `C:\Users\PCUser\Documents\Jp343-git\overwatched\mikan-test\mikan-unpacked\`
