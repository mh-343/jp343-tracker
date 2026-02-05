// =============================================================================
// JP343 Extension - Netflix Content Script
// Erkennt Video-Playback auf Netflix mit verbesserter Metadata-Extraktion
// =============================================================================

import type { VideoState } from '../../types';

// Erweiterte Metadata fuer Netflix
interface NetflixMetadata {
  title: string;           // Haupttitel (Serie oder Film)
  episodeTitle: string | null;  // Episode-Titel falls Serie
  seasonNumber: number | null;
  episodeNumber: number | null;
  isMovie: boolean;
  thumbnailUrl: string | null;
}

export default defineContentScript({
  matches: ['*://*.netflix.com/*'],
  runAt: 'document_idle',

  main() {
    console.log('[JP343] Netflix Content Script geladen');

    let currentVideoElement: HTMLVideoElement | null = null;
    let lastTitle: string = '';
    let lastVideoId: string | null = null;
    let cachedMetadata: NetflixMetadata | null = null;
    let bestKnownTitle: string = '';  // Bester Titel den wir je gesehen haben
    let isCurrentlyInAd: boolean = false;  // Werbung wird gerade abgespielt
    let pendingVideoId: string | null = null;  // Video-ID die auf Werbe-Ende wartet

    // =======================================================================
    // DEBUG LOGGING - Erfasst alle DOM-Aenderungen und Video-Events
    // =======================================================================

    const DEBUG_MODE = true;  // Auf false setzen um Debug-Logging zu deaktivieren
    const LOG_BUFFER: string[] = [];  // Sammelt alle Logs fuer Export
    const MAX_LOG_ENTRIES = 5000;  // Limit um Speicher zu schonen

    function debugLog(category: string, message: string, data?: Record<string, unknown>): void {
      if (!DEBUG_MODE) return;
      const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);
      const fullTimestamp = new Date().toISOString();
      const logLine = `[${fullTimestamp}] [${category}] ${message}`;

      // In Console ausgeben
      console.log(`[JP343 DEBUG ${timestamp}] [${category}]`, message, data || '');

      // In Buffer speichern (mit JSON-serialisierten Daten)
      const bufferEntry = data
        ? `${logLine} ${JSON.stringify(data)}`
        : logLine;

      LOG_BUFFER.push(bufferEntry);

      // Buffer-Groesse begrenzen
      if (LOG_BUFFER.length > MAX_LOG_ENTRIES) {
        LOG_BUFFER.shift();
      }
    }

    // Injiziere Debug-Funktionen in den Page Context (damit sie in der Console funktionieren)
    // Content Scripts haben einen isolierten Context, daher muessen wir ein <script>-Tag nutzen
    const injectPageScript = () => {
      const script = document.createElement('script');
      script.textContent = `
        // JP343 Debug-Funktionen im Page Context
        window.JP343_downloadLogs = function() {
          // Request Logs vom Content Script via CustomEvent
          window.dispatchEvent(new CustomEvent('JP343_REQUEST_LOGS'));
        };

        window.JP343_clearLogs = function() {
          window.dispatchEvent(new CustomEvent('JP343_CLEAR_LOGS'));
        };

        window.JP343_logStatus = function() {
          window.dispatchEvent(new CustomEvent('JP343_LOG_STATUS'));
        };

        console.log('[JP343] Debug-Logging aktiv. Befehle: JP343_downloadLogs(), JP343_clearLogs(), JP343_logStatus()');
      `;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    };

    // Event-Listener im Content Script Context
    window.addEventListener('JP343_REQUEST_LOGS', () => {
      const content = LOG_BUFFER.join('\n');
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `jp343-netflix-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.log`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      console.log('[JP343] Log-Datei heruntergeladen mit', LOG_BUFFER.length, 'Eintraegen');
    });

    window.addEventListener('JP343_CLEAR_LOGS', () => {
      LOG_BUFFER.length = 0;
      console.log('[JP343] Log-Buffer geleert');
    });

    window.addEventListener('JP343_LOG_STATUS', () => {
      console.log('[JP343] Log-Buffer:', LOG_BUFFER.length, 'Eintraege');
      console.log('[JP343] Befehle: JP343_downloadLogs(), JP343_clearLogs(), JP343_logStatus()');
    });

    // Script sofort injizieren
    if (document.head || document.documentElement) {
      injectPageScript();
    } else {
      // Falls DOM noch nicht bereit, warten
      const observer = new MutationObserver(() => {
        if (document.head || document.documentElement) {
          injectPageScript();
          observer.disconnect();
        }
      });
      observer.observe(document, { childList: true, subtree: true });
    }

    // Sammelt alle relevanten UI-Elemente fuer Debug-Output
    function collectUIState(): Record<string, unknown> {
      const video = document.querySelector('video') as HTMLVideoElement | null;
      return {
        // Video-Element State
        videoExists: !!video,
        videoPaused: video?.paused ?? null,
        videoEnded: video?.ended ?? null,
        videoDuration: video?.duration ?? null,
        videoCurrentTime: video?.currentTime ?? null,

        // URL & Titel
        url: window.location.href,
        videoIdFromUrl: window.location.pathname.match(/\/watch\/(\d+)/)?.[1] || null,
        documentTitle: document.title,

        // Bekannte Netflix UI-Elemente
        nextEpisodeBtn: !!document.querySelector('[data-uia="next-episode-seamless-button"]'),
        nextEpisodeDraining: !!document.querySelector('[data-uia="next-episode-seamless-button-draining"]'),
        skipPreplay: !!document.querySelector('.watch-video--skip-preplay-button'),
        skipContent: !!document.querySelector('.watch-video--skip-content-button'),
        skipIntro: !!document.querySelector('[aria-label="Skip Intro"], [data-uia="player-skip-intro"]'),
        skipRecap: !!document.querySelector('[aria-label="Skip Recap"], [data-uia="player-skip-recap"]'),

        // Potentielle Ad-Elemente (alle data-uia mit "ad" im Namen)
        adDataUiaElements: Array.from(document.querySelectorAll('[data-uia*="ad"]')).map(el => ({
          tag: el.tagName,
          dataUia: el.getAttribute('data-uia'),
          classes: el.className,
          visible: (el as HTMLElement).offsetParent !== null
        })),

        // Alle sichtbaren data-uia Elemente
        allVisibleDataUia: Array.from(document.querySelectorAll('[data-uia]'))
          .filter(el => (el as HTMLElement).offsetParent !== null)
          .slice(0, 20)  // Limit auf 20
          .map(el => el.getAttribute('data-uia')),

        // Body und Player Klassen
        bodyClasses: document.body.className,
        playerClasses: document.querySelector('.watch-video, .AkiraPlayer')?.className || null,

        // Interstitial/Overlay Elemente
        interstitialElements: Array.from(document.querySelectorAll('[class*="interstitial"], [class*="Interstitial"]')).map(el => ({
          tag: el.tagName,
          classes: el.className,
          visible: (el as HTMLElement).offsetParent !== null
        })),

        // Interne States
        isCurrentlyInAd: isCurrentlyInAd,
        pendingVideoId: pendingVideoId,
        lastVideoId: lastVideoId,
        bestKnownTitle: bestKnownTitle
      };
    }

    // DOM Mutation Observer fuer Debug
    if (DEBUG_MODE) {
      const debugMutationObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              const dataUia = node.getAttribute?.('data-uia');
              const classes = node.className || '';
              const ariaLabel = node.getAttribute?.('aria-label');

              // Logge interessante Elemente
              const isInteresting =
                dataUia ||
                /ad|skip|interstitial|preplay|next-episode|seamless|overlay|countdown/i.test(classes) ||
                /ad|skip/i.test(ariaLabel || '');

              if (isInteresting) {
                debugLog('DOM_ADD', 'Neues Element hinzugefuegt', {
                  tag: node.tagName,
                  dataUia: dataUia,
                  classes: classes,
                  id: node.id,
                  ariaLabel: ariaLabel,
                  innerText: node.innerText?.slice(0, 100),
                  visible: node.offsetParent !== null,
                  rect: node.getBoundingClientRect()
                });
              }
            }
          });

          mutation.removedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              const dataUia = node.getAttribute?.('data-uia');
              if (dataUia && /ad|skip|interstitial|next-episode/i.test(dataUia)) {
                debugLog('DOM_REMOVE', 'Element entfernt', {
                  tag: node.tagName,
                  dataUia: dataUia
                });
              }
            }
          });
        });
      });

      debugMutationObserver.observe(document.body, {
        childList: true,
        subtree: true
      });

      debugLog('INIT', 'Debug Mutation Observer gestartet');
    }

    function findVideoElement(): HTMLVideoElement | null {
      return document.querySelector('video') as HTMLVideoElement;
    }

    // =======================================================================
    // NETFLIX WERBUNG ERKENNUNG
    // =======================================================================

    function isAdPlaying(): boolean {
      // WICHTIG: Ad-Detection NUR auf /watch/ URLs
      // Auf Browse/Home gibt es Elemente die "-ad" enthalten aber keine echte Werbung sind
      if (!window.location.pathname.includes('/watch/')) {
        return false;
      }

      // Netflix Ads haben typischerweise spezifische UI-Elemente
      const adIndicators = [
        // GEFUNDEN VIA DEBUG: Netflix Pause-Ad (Werbung bei Pause oder am Anfang)
        '[data-uia="pause-ad"]',
        '[data-uia="video-ad"]',
        '[data-uia*="-ad"]',  // Alle data-uia die mit "-ad" enden
        // "Skip Ad" oder "Skip Intro" Button (Werbung)
        '[data-uia="ad-skip"]',
        '[data-uia="player-skip-ad"]',
        '.skip-ad',
        // Ad-Countdown Anzeige
        '[data-uia="ad-progress"]',
        '.ad-countdown',
        '.ad-progress-bar',
        // Netflix Ad-Overlay Container
        '.watch-video--ad-playing',
        '.AkiraPlayer--ad-interstitial',
        '[data-uia="interstitial-container"]',
        // Weitere Ad-bezogene Elemente
        '.interstitial-text',
        '.interstitial-container',
        // Playback Notification (Pause-Werbung)
        '.playback-notification--pause',
        // "Ad" Text irgendwo sichtbar
        '[class*="adBreak"]',
        '[class*="ad-break"]'
      ];

      for (const selector of adIndicators) {
        const element = document.querySelector(selector);
        if (element) {
          // Element gefunden und sichtbar?
          const rect = element.getBoundingClientRect();
          const isVisible = rect.width > 0 && rect.height > 0;
          if (isVisible) {
            console.log('[JP343] Netflix Ad erkannt via:', selector);
            return true;
          }
        }
      }

      // Zusaetzlich: Pruefen ob Body oder Player spezielle Ad-Klassen hat
      const body = document.body;
      const player = document.querySelector('.watch-video, .AkiraPlayer, [data-uia="watch-video"]');
      const adClasses = ['ad-playing', 'ad-interstitial', 'interstitial', 'ad-mode'];

      for (const className of adClasses) {
        if (body.classList.contains(className) || player?.classList.contains(className)) {
          console.log('[JP343] Netflix Ad erkannt via Klasse:', className);
          return true;
        }
      }

      // Check: Ist das Video extrem kurz? (Ads sind meist < 60 Sekunden)
      // Aber nur wenn wir schon eine "echte" Video-ID hatten
      const video = findVideoElement();
      if (video && video.duration > 0 && video.duration < 45 && pendingVideoId) {
        // Kurzes Video nach einem normalen Video → wahrscheinlich Ad
        console.log('[JP343] Netflix: Kurzes Video erkannt (', Math.round(video.duration), 's) - moeglicherweise Werbung');
        return true;
      }

      return false;
    }

    function handleAdStateChange(): void {
      const adPlaying = isAdPlaying();

      if (adPlaying && !isCurrentlyInAd) {
        // Werbung hat begonnen
        isCurrentlyInAd = true;
        debugLog('AD_STATE', '=== WERBUNG BEGINNT ===', collectUIState());
        console.log('[JP343] Netflix: Werbung beginnt');
        sendMessage('AD_START');
      } else if (!adPlaying && isCurrentlyInAd) {
        // Werbung ist beendet
        isCurrentlyInAd = false;
        debugLog('AD_STATE', '=== WERBUNG BEENDET ===', collectUIState());
        console.log('[JP343] Netflix: Werbung beendet');
        sendMessage('AD_END');

        // Falls wir auf ein Video gewartet haben, jetzt starten
        if (pendingVideoId) {
          debugLog('AD_STATE', 'Starte gemerkte Session', { pendingVideoId });
          console.log('[JP343] Netflix: Starte gemerkte Session nach Werbe-Ende');
          setTimeout(() => {
            const state = getCurrentVideoState();
            if (state && state.isPlaying && !isAdPlaying()) {
              lastVideoId = pendingVideoId;
              lastTitle = state.title;
              sendMessage('VIDEO_PLAY', { state });
            }
            pendingVideoId = null;
          }, 500);
        }
      }
    }

    // Ad-Status alle 500ms pruefen
    setInterval(handleAdStateChange, 500);

    // DEBUG: Periodisch alle 5 Sekunden vollstaendigen State loggen (nur wenn Video laeuft)
    if (DEBUG_MODE) {
      setInterval(() => {
        const video = findVideoElement();
        if (video && !video.paused) {
          debugLog('PERIODIC', 'Periodischer State-Check', collectUIState());
        }
      }, 5000);
    }

    // =======================================================================
    // VERBESSERTE METADATA-EXTRAKTION
    // =======================================================================

    function extractNetflixMetadata(): NetflixMetadata {
      const metadata: NetflixMetadata = {
        title: 'Netflix Content',
        episodeTitle: null,
        seasonNumber: null,
        episodeNumber: null,
        isMovie: true,
        thumbnailUrl: null
      };

      // 1. PRIMAER: Document Title - ist IMMER verfuegbar!
      // Netflix setzt: "Serienname | Netflix" oder "Filmname | Netflix"
      // ABER: manchmal ist es anfangs nur "Netflix"
      const docTitle = document.title;
      const isGenericTitle = !docTitle ||
        docTitle.toLowerCase() === 'netflix' ||
        docTitle.toLowerCase().includes('netflix home') ||
        docTitle.toLowerCase().includes('browse');

      if (!isGenericTitle) {
        // Entferne " | Netflix", " - Netflix", etc.
        const cleanTitle = docTitle
          .replace(/\s*[\|–-]\s*Netflix.*$/i, '')
          .replace(/\s*-\s*Watch.*$/i, '')  // "Title - Watch on Netflix"
          .trim();
        if (cleanTitle && cleanTitle.length > 0 && cleanTitle.toLowerCase() !== 'netflix') {
          const parsed = parseNetflixTitle(cleanTitle);
          Object.assign(metadata, parsed);
          // Besten Titel merken
          if (metadata.title !== 'Netflix Content') {
            bestKnownTitle = metadata.title;
          }
        }
      }

      // Wenn document.title nur "Netflix" ist, nutze gespeicherten besten Titel
      if (metadata.title === 'Netflix Content' && bestKnownTitle) {
        metadata.title = bestKnownTitle;
      }

      // 2. OPTIONAL: Player Controls (nur wenn sichtbar, fuer mehr Details)
      // Diese haben manchmal Episode-Info die im document.title fehlt
      if (metadata.title !== 'Netflix Content') {
        const titleSelectors = [
          '[data-uia="video-title"]',
          '.video-title h4',
          '.video-title',
          '.ellipsize-text[data-uia]',
          '.player-controls-content .ellipsize-text'
        ];

        for (const selector of titleSelectors) {
          const element = document.querySelector(selector);
          if (element?.textContent?.trim()) {
            const rawTitle = element.textContent.trim();
            const parsed = parseNetflixTitle(rawTitle);
            // Nur uebernehmen wenn wir mehr Details bekommen (z.B. Episode-Info)
            if (parsed.seasonNumber || parsed.episodeNumber) {
              Object.assign(metadata, parsed);
              break;
            }
          }
        }
      }

      // 3. Episode-Info aus separaten Elementen
      const episodeInfoSelectors = [
        '[data-uia="video-title"] + span',
        '.video-title span:not(.title)',
        '.ellipsize-text + .ellipsize-text'
      ];

      for (const selector of episodeInfoSelectors) {
        const element = document.querySelector(selector);
        if (element?.textContent?.trim()) {
          const episodeInfo = parseEpisodeInfo(element.textContent.trim());
          if (episodeInfo.seasonNumber || episodeInfo.episodeNumber) {
            metadata.seasonNumber = episodeInfo.seasonNumber;
            metadata.episodeNumber = episodeInfo.episodeNumber;
            metadata.episodeTitle = episodeInfo.episodeTitle;
            metadata.isMovie = false;
            break;
          }
        }
      }

      // 4. Thumbnail aus Netflix Poster/Billboard
      metadata.thumbnailUrl = extractThumbnail();

      return metadata;
    }

    function parseNetflixTitle(rawTitle: string): Partial<NetflixMetadata> {
      const result: Partial<NetflixMetadata> = {
        title: rawTitle,
        isMovie: true
      };

      // Pattern 1: "Serienname: S1:E5 Episodentitel"
      const colonPattern = /^(.+?):\s*S(\d+):E(\d+)\s*(.*)$/i;
      let match = rawTitle.match(colonPattern);
      if (match) {
        result.title = match[1].trim();
        result.seasonNumber = parseInt(match[2], 10);
        result.episodeNumber = parseInt(match[3], 10);
        result.episodeTitle = match[4].trim() || null;
        result.isMovie = false;
        return result;
      }

      // Pattern 2: "Serienname - Season 1: Episode 5"
      const longPattern = /^(.+?)\s*[-–]\s*Season\s*(\d+).*Episode\s*(\d+)(.*)$/i;
      match = rawTitle.match(longPattern);
      if (match) {
        result.title = match[1].trim();
        result.seasonNumber = parseInt(match[2], 10);
        result.episodeNumber = parseInt(match[3], 10);
        result.episodeTitle = match[4].replace(/^[\s:–-]+/, '').trim() || null;
        result.isMovie = false;
        return result;
      }

      // Pattern 3: "S1 E5" oder "Season 1 Episode 5" irgendwo im Titel
      const inlinePattern = /S(\d+)\s*E(\d+)/i;
      match = rawTitle.match(inlinePattern);
      if (match) {
        result.seasonNumber = parseInt(match[1], 10);
        result.episodeNumber = parseInt(match[2], 10);
        // Titel ist alles vor dem Pattern
        const titlePart = rawTitle.substring(0, rawTitle.indexOf(match[0])).trim();
        if (titlePart) {
          result.title = titlePart.replace(/[-–:]\s*$/, '').trim();
        }
        result.isMovie = false;
        return result;
      }

      return result;
    }

    function parseEpisodeInfo(text: string): { seasonNumber: number | null; episodeNumber: number | null; episodeTitle: string | null } {
      const result = { seasonNumber: null as number | null, episodeNumber: null as number | null, episodeTitle: null as string | null };

      // "S1:E5" oder "Season 1, Episode 5"
      const patterns = [
        /S(\d+):?E(\d+)/i,
        /Season\s*(\d+).*Episode\s*(\d+)/i,
        /Staffel\s*(\d+).*Folge\s*(\d+)/i,  // Deutsch
        /(\d+)x(\d+)/  // 1x05 Format
      ];

      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          result.seasonNumber = parseInt(match[1], 10);
          result.episodeNumber = parseInt(match[2], 10);
          // Rest als Episode-Titel
          const rest = text.replace(match[0], '').replace(/^[\s:–-]+/, '').trim();
          if (rest && rest.length > 2) {
            result.episodeTitle = rest;
          }
          break;
        }
      }

      return result;
    }

    function extractThumbnail(): string | null {
      // 1. Mini-Preview Thumbnail
      const miniPreview = document.querySelector('.mini-preview-player img') as HTMLImageElement;
      if (miniPreview?.src) {
        return miniPreview.src;
      }

      // 2. Billboard/Poster Image
      const billboardSelectors = [
        '.billboard-row img',
        '.jawbone-title-link img',
        '.title-card img',
        '.bob-card img',
        '[data-uia="billboard"] img'
      ];

      for (const selector of billboardSelectors) {
        const img = document.querySelector(selector) as HTMLImageElement;
        if (img?.src && !img.src.includes('transparent')) {
          return img.src;
        }
      }

      // 3. Background Image aus Style
      const bgSelectors = [
        '.billboard-row .billboard-image',
        '.hero-image-wrapper'
      ];

      for (const selector of bgSelectors) {
        const el = document.querySelector(selector) as HTMLElement;
        if (el) {
          const bg = window.getComputedStyle(el).backgroundImage;
          const urlMatch = bg.match(/url\(["']?([^"')]+)["']?\)/);
          if (urlMatch && urlMatch[1]) {
            return urlMatch[1];
          }
        }
      }

      return null;
    }

    // =======================================================================
    // FORMATIERTER TITEL FUER TRACKING
    // =======================================================================

    function getFormattedTitle(): string {
      const metadata = extractNetflixMetadata();
      cachedMetadata = metadata;

      if (metadata.isMovie) {
        return metadata.title;
      }

      // Serie: "Serienname S1E5: Episodentitel" oder "Serienname S1E5"
      let formatted = metadata.title;
      if (metadata.seasonNumber && metadata.episodeNumber) {
        formatted += ` S${metadata.seasonNumber}E${metadata.episodeNumber}`;
      }
      if (metadata.episodeTitle) {
        formatted += `: ${metadata.episodeTitle}`;
      }
      return formatted;
    }

    function getVideoId(): string | null {
      const match = window.location.pathname.match(/\/watch\/(\d+)/);
      return match ? match[1] : null;
    }

    function getCurrentVideoState(): VideoState | null {
      const video = findVideoElement();
      if (!video) return null;

      const videoId = getVideoId();
      if (!videoId) return null;

      const metadata = cachedMetadata || extractNetflixMetadata();

      return {
        isPlaying: !video.paused && !video.ended,
        currentTime: video.currentTime,
        duration: video.duration || 0,
        title: getFormattedTitle(),
        url: window.location.href,
        platform: 'netflix',
        isAd: isCurrentlyInAd || isAdPlaying(),  // Echte Ad-Erkennung
        thumbnailUrl: metadata.thumbnailUrl,
        videoId: videoId,
        // Netflix hat keine Channel-Informationen (kein Creator-Konzept wie YouTube)
        channelId: null,
        channelName: null,
        channelUrl: null
      };
    }

    async function sendMessage(type: string, data?: Record<string, unknown>): Promise<void> {
      try {
        await browser.runtime.sendMessage({
          type,
          platform: 'netflix',
          ...data
        });
      } catch (error) {
        console.log('[JP343] Message error:', error);
      }
    }

    function clearMetadataCache(): void {
      cachedMetadata = null;
    }

    function attachVideoEvents(video: HTMLVideoElement): void {
      if (video.hasAttribute('data-jp343-tracked')) {
        return;
      }
      video.setAttribute('data-jp343-tracked', 'true');

      video.addEventListener('play', () => {
        // DEBUG: Vollstaendiger UI-State bei Play-Event
        debugLog('VIDEO_PLAY', '=== VIDEO PLAY EVENT ===', collectUIState());

        // Metadata neu laden bei Play
        clearMetadataCache();
        const videoId = getVideoId();

        // Bei Werbung: Video-ID merken, aber NICHT tracken
        // Ad-Detection prüft alle 500ms - Timer pausiert automatisch bei Werbung
        if (isAdPlaying() || isCurrentlyInAd) {
          debugLog('VIDEO_PLAY', 'Play waehrend Werbung - wird ignoriert', { videoId, isCurrentlyInAd, isAdPlaying: isAdPlaying() });
          console.log('[JP343] Netflix Play waehrend Werbung - wird ignoriert, Video-ID gemerkt:', videoId);
          pendingVideoId = videoId;
          if (!isCurrentlyInAd) {
            isCurrentlyInAd = true;
            sendMessage('AD_START');
          }
          return;
        }

        const state = getCurrentVideoState();
        if (state) {
          lastVideoId = videoId;
          lastTitle = state.title;
          debugLog('VIDEO_PLAY', 'Tracking gestartet', { videoId, title: state.title });
          console.log('[JP343] Netflix Play:', state.title, '(ID:', lastVideoId, ')');
          sendMessage('VIDEO_PLAY', { state });
        }
      });

      video.addEventListener('pause', () => {
        debugLog('VIDEO_PAUSE', '=== VIDEO PAUSE EVENT ===', collectUIState());
        sendMessage('VIDEO_PAUSE');
      });

      video.addEventListener('ended', () => {
        debugLog('VIDEO_ENDED', '=== VIDEO ENDED EVENT ===', collectUIState());

        // Bei Werbung: NICHT VIDEO_ENDED senden (wuerde Session beenden)
        if (isCurrentlyInAd) {
          debugLog('VIDEO_ENDED', 'Ended waehrend Werbung - wird ignoriert', { isCurrentlyInAd });
          console.log('[JP343] Netflix Video ended waehrend Werbung - wird ignoriert');
          return;
        }
        sendMessage('VIDEO_ENDED');
        clearMetadataCache();
      });

      // DEBUG: Auch loadedmetadata Event loggen
      video.addEventListener('loadedmetadata', () => {
        debugLog('VIDEO_META', '=== VIDEO LOADEDMETADATA ===', {
          duration: video.duration,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          ...collectUIState()
        });
      });

      // DEBUG: Seeking Events
      video.addEventListener('seeking', () => {
        debugLog('VIDEO_SEEK', 'Seeking', { currentTime: video.currentTime });
      });

      // Periodische Updates (alle 30 Sekunden)
      setInterval(() => {
        // Keine Updates waehrend Werbung
        if (isCurrentlyInAd) {
          return;
        }

        const state = getCurrentVideoState();
        if (state && state.isPlaying) {
          const currentVideoId = getVideoId();

          // Video-Wechsel NUR anhand der Video-ID erkennen (nicht Titel!)
          // Titel kann sich aendern wenn Player-Controls ein/ausblenden
          if (currentVideoId && lastVideoId && currentVideoId !== lastVideoId) {
            console.log('[JP343] Netflix Video-Wechsel (ID):', lastVideoId, '->', currentVideoId);
            lastVideoId = currentVideoId;
            lastTitle = state.title;
            clearMetadataCache();
            sendMessage('VIDEO_ENDED');
            setTimeout(() => {
              const newState = getCurrentVideoState();
              if (newState && newState.isPlaying && !isCurrentlyInAd) {
                sendMessage('VIDEO_PLAY', { state: newState });
              }
            }, 500);
          } else {
            // Nur Titel aktualisieren wenn wir einen guten haben
            if (state.title && state.title !== 'Netflix Content') {
              lastTitle = state.title;
            }
            sendMessage('VIDEO_STATE_UPDATE', { state });
          }
        }
      }, 30000);

      console.log('[JP343] Netflix Video Events gebunden');
    }

    const observer = new MutationObserver(() => {
      const video = findVideoElement();

      if (video && video !== currentVideoElement) {
        currentVideoElement = video;
        clearMetadataCache();
        attachVideoEvents(video);
        const videoId = getVideoId();

        // Falls neues Video bereits laeuft
        if (!video.paused && !video.ended && videoId) {
          // Bei Werbung: nur Video-ID merken
          // Ad-Detection läuft alle 500ms - bei Werbung wird Timer automatisch pausiert
          if (isAdPlaying() || isCurrentlyInAd) {
            debugLog('OBSERVER', 'Neues Video waehrend Werbung', { videoId });
            console.log('[JP343] Netflix: Neues Video waehrend Werbung erkannt, ID gemerkt:', videoId);
            pendingVideoId = videoId;
            if (!isCurrentlyInAd) {
              isCurrentlyInAd = true;
              sendMessage('AD_START');
            }
          } else {
            // Kein Ad erkannt - sofort tracken
            // Falls doch Werbung kommt, pausiert die Ad-Detection den Timer
            console.log('[JP343] Netflix: Neues Video laeuft bereits');
            lastVideoId = videoId;
            lastTitle = getFormattedTitle();
            const state = getCurrentVideoState();
            if (state) {
              sendMessage('VIDEO_PLAY', { state });
            }
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    const initialVideo = findVideoElement();
    if (initialVideo) {
      currentVideoElement = initialVideo;
      attachVideoEvents(initialVideo);
      const videoId = getVideoId();

      // Falls Video bereits laeuft (Content Script wurde nach Video-Start geladen)
      if (!initialVideo.paused && !initialVideo.ended && videoId) {
        // Pruefen ob Werbung laeuft
        if (isAdPlaying()) {
          console.log('[JP343] Netflix: Video laeuft bereits waehrend Werbung');
          isCurrentlyInAd = true;
          pendingVideoId = videoId;
          sendMessage('AD_START');
        } else {
          console.log('[JP343] Netflix: Video laeuft bereits, starte Tracking');
          lastVideoId = videoId;
          lastTitle = getFormattedTitle();
          const state = getCurrentVideoState();
          if (state) {
            sendMessage('VIDEO_PLAY', { state });
          }
        }
      }
    }

    // URL-Wechsel erkennen (SPA Navigation)
    let lastUrl = window.location.href;
    setInterval(() => {
      if (window.location.href !== lastUrl) {
        debugLog('URL_CHANGE', '=== URL WECHSEL ===', {
          oldUrl: lastUrl,
          newUrl: window.location.href,
          ...collectUIState()
        });
        console.log('[JP343] Netflix URL-Wechsel:', lastUrl, '->', window.location.href);
        lastUrl = window.location.href;
        clearMetadataCache();

        // Warten bis neues Video geladen
        setTimeout(() => {
          const video = findVideoElement();
          if (video && video !== currentVideoElement) {
            debugLog('URL_CHANGE', 'Neues Video nach URL-Wechsel erkannt', collectUIState());
            currentVideoElement = video;
            attachVideoEvents(video);
            lastVideoId = getVideoId();
            lastTitle = getFormattedTitle();
          }
        }, 1000);
      }

    }, 1000);

    // Title-Observer: Netflix setzt Titel manchmal verzoegert
    const titleObserver = new MutationObserver(() => {
      const docTitle = document.title;
      if (docTitle && docTitle.toLowerCase() !== 'netflix' && !docTitle.toLowerCase().includes('home')) {
        const cleanTitle = docTitle.replace(/\s*[\|–-]\s*Netflix.*$/i, '').trim();
        if (cleanTitle && cleanTitle.length > 2 && cleanTitle.toLowerCase() !== 'netflix') {
          if (cleanTitle !== bestKnownTitle) {
            console.log('[JP343] Netflix: Neuer Titel erkannt:', cleanTitle);
            bestKnownTitle = cleanTitle;
            clearMetadataCache();
          }
        }
      }
    });

    // Beobachte <title> Element
    const titleElement = document.querySelector('title');
    if (titleElement) {
      titleObserver.observe(titleElement, { childList: true, characterData: true, subtree: true });
    }

    // Periodisch Titel pruefen (alle 5 Sekunden fuer die ersten 30 Sekunden)
    let titleCheckCount = 0;
    const titleCheckInterval = setInterval(() => {
      titleCheckCount++;
      const docTitle = document.title;
      if (docTitle && docTitle.toLowerCase() !== 'netflix') {
        const cleanTitle = docTitle.replace(/\s*[\|–-]\s*Netflix.*$/i, '').trim();
        if (cleanTitle && cleanTitle.length > 2 && cleanTitle !== bestKnownTitle) {
          console.log('[JP343] Netflix: Titel gefunden (Check #' + titleCheckCount + '):', cleanTitle);
          bestKnownTitle = cleanTitle;
          clearMetadataCache();
        }
      }
      // Nach 30 Sekunden aufhoeren
      if (titleCheckCount >= 6) {
        clearInterval(titleCheckInterval);
      }
    }, 5000);

    // Debug: Zeige Status nach 3 Sekunden
    setTimeout(() => {
      const video = findVideoElement();
      const videoId = getVideoId();
      const metadata = extractNetflixMetadata();
      const adPlaying = isAdPlaying();
      console.log('[JP343] Netflix Debug:', {
        documentTitle: document.title,
        bestKnownTitle: bestKnownTitle,
        videoFound: !!video,
        videoPlaying: video ? !video.paused : false,
        videoId: videoId,
        url: window.location.href,
        extractedMetadata: metadata,
        isCurrentlyInAd: isCurrentlyInAd,
        adDetected: adPlaying,
        pendingVideoId: pendingVideoId
      });

      // Fallback: Falls Video laeuft aber nicht getrackt wird
      // NICHT bei Werbung!
      if (video && !video.paused && !video.ended && videoId && !adPlaying && !isCurrentlyInAd) {
        const state = getCurrentVideoState();
        if (state) {
          console.log('[JP343] Netflix: Starte verzoegertes Tracking');
          lastVideoId = videoId;
          lastTitle = state.title;
          sendMessage('VIDEO_PLAY', { state });
        }
      } else if (video && !video.paused && (adPlaying || isCurrentlyInAd) && videoId) {
        console.log('[JP343] Netflix: Video laeuft waehrend Werbung - Tracking pausiert');
        pendingVideoId = videoId;
      }
    }, 3000);
  }
});
