// =============================================================================
// JP343 Extension - Crunchyroll Content Script
// =============================================================================

import type { VideoState } from '../../types';

// Crunchyroll-spezifische Metadata
interface CrunchyrollMetadata {
  title: string;           // Anime-Titel
  episodeTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  thumbnailUrl: string | null;
  seriesName: string | null;  // Fuer channelName/Projekt-Zuordnung
}

export default defineContentScript({
  matches: ['*://*.crunchyroll.com/*'],
  allFrames: true,
  runAt: 'document_idle',

  main() {
    // Cleanup-Registry (Fix 4+5) — muss vor erstem intervalIds.push stehen
    const observers: MutationObserver[] = [];
    const intervalIds: ReturnType<typeof setInterval>[] = [];
    function cleanup(): void {
      observers.forEach(o => o.disconnect());
      intervalIds.forEach(clearInterval);
      observers.length = 0;
      intervalIds.length = 0;
    }
    window.addEventListener('pagehide', cleanup);

    // Debug-Logging — muss vor erstem log() Aufruf stehen
    const DEBUG_MODE = import.meta.env.DEV;  // true in Dev, false in Prod (Fix 11)
    const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};

    const buildTimestamp = new Date().toISOString();
    log('%c[JP343] Crunchyroll Content Script v1.4.0-DATA-ATTR-FIX geladen', 'color: #00ff00; font-weight: bold; font-size: 14px');
    log('[JP343] Build: ' + buildTimestamp);

    // Pruefen ob wir im Haupt-Frame oder iframe sind
    const isIframe = window !== window.top;
    const isMainFrame = !isIframe;
    log('[JP343] Context:', isIframe ? 'iframe' : 'Haupt-Frame');

    // Funktion: Video-Metadaten an iframe senden (wird bei URL-Wechsel neu aufgerufen)
    function sendVideoMetadataToIframe() {
      const videoId = window.location.pathname.match(/\/watch\/([A-Z0-9]+)/i)?.[1];
      if (!videoId) return;

      log('[JP343] Haupt-Frame: Video-ID erkannt:', videoId);

      // Thumbnail wird im Interval extrahiert (og:image kann spaeter geladen werden)
      let thumbnail: string | null = null;

      // Warte bis iframe geladen ist und sende Video-ID wiederholt via postMessage
      let iframeFound = false;
      let messagesSent = 0;
      const maxMessages = 25; // 25 * 200ms = 5 Sekunden
      let ackReceived = false;

      // Lausche auf Bestätigung vom iframe (Fix 3: Origin-Validierung)
      const ackListener = (event: MessageEvent) => {
        if (event.origin && !event.origin.endsWith('.crunchyroll.com') && !event.origin.endsWith('.crunchyroll.co.jp')) {
          return;
        }
        if (event.data && event.data.type === 'JP343_VIDEO_ID_ACK' && event.data.videoId === videoId) {
          if (!ackReceived) {
            ackReceived = true;
            log('[JP343] Haupt-Frame: Bestätigung vom iframe erhalten nach', messagesSent, 'Nachrichten');
            clearInterval(checkIframe);
            window.removeEventListener('message', ackListener);
          }
        }
      };
      window.addEventListener('message', ackListener);

      const checkIframe = setInterval(() => {
        if (ackReceived) return; // Stop wenn bereits bestätigt

        const iframe = document.querySelector('iframe[src*="vilos"]') as HTMLIFrameElement;
        if (iframe && iframe.contentWindow) {
          if (!iframeFound) {
            log('[JP343] Haupt-Frame: iframe gefunden, sende Video-ID wiederholt...');
            iframeFound = true;
          }

          // Thumbnail bei jedem Versuch erneut pruefen (og:image kann spaeter geladen werden)
          if (!thumbnail) {
            const ogImage = document.querySelector('meta[property="og:image"]');
            thumbnail = ogImage?.getAttribute('content') || null;
            if (thumbnail) {
              log('[JP343] Haupt-Frame: Thumbnail extrahiert:', thumbnail.substring(0, 60) + '...');
            }
          }

          // Episode-Titel aus DOM
          const episodeHeading = document.querySelector('h1[class*="heading"][class*="title"]')
            || document.querySelector('h1.title');
          const episodeText = episodeHeading?.textContent?.trim() || null;

          // Daten an iframe senden
          let targetOrigin = 'https://www.crunchyroll.com';
          try {
            const iframeUrl = new URL(iframe.src);
            targetOrigin = iframeUrl.origin;
          } catch { /* Fallback auf Crunchyroll-Origin */ }

          iframe.contentWindow.postMessage({
            type: 'JP343_VIDEO_ID',
            videoId: videoId,
            title: document.title,
            thumbnail: thumbnail,
            episodeText: episodeText,
            watchUrl: window.location.href
          }, targetOrigin);

          messagesSent++;

          // Log nur erste Nachricht um Console nicht zu spammen
          if (messagesSent === 1) {
            log('[JP343] Haupt-Frame: Video-ID wird gesendet:', videoId);
          }

          // Nach max. Versuchen aufhoeren
          if (messagesSent >= maxMessages) {
            log('[JP343] Haupt-Frame: Video-ID', maxMessages, 'mal gesendet (keine Bestätigung erhalten)');
            clearInterval(checkIframe);
            window.removeEventListener('message', ackListener);
          }
        }
      }, 200); // Alle 200ms senden

      // Nach 10 Sekunden aufgeben
      setTimeout(() => {
        clearInterval(checkIframe);
        window.removeEventListener('message', ackListener);
      }, 10000);
    }

    // Im Haupt-Frame: Initial senden + URL-Wechsel ueberwachen
    if (isMainFrame) {
      // Initial beim Page-Load
      sendVideoMetadataToIframe();

      // URL-Wechsel erkennen (React SPA Navigation)
      let lastMainFrameUrl = window.location.href;
      intervalIds.push(setInterval(() => {
        if (window.location.href !== lastMainFrameUrl) {
          log('[JP343] Haupt-Frame: URL-Wechsel erkannt:', lastMainFrameUrl, '->', window.location.href);
          lastMainFrameUrl = window.location.href;

          // Warte kurz bis DOM aktualisiert ist, dann sende neu
          setTimeout(() => {
            sendVideoMetadataToIframe();
          }, 500);
        }
      }, 1000));
    }

    let currentVideoElement: HTMLVideoElement | null = null;
    let lastTitle: string = '';
    let lastVideoId: string | null = null;
    let cachedMetadata: CrunchyrollMetadata | null = null;
    let bestKnownTitle: string = '';  // Bester Titel den wir je gesehen haben
    let isCurrentlyInAd: boolean = false;  // Werbung wird gerade abgespielt
    let pendingVideoId: string | null = null;  // Video-ID die auf Werbe-Ende wartet

    // =======================================================================
    // DEBUG LOGGING - Erfasst alle DOM-Aenderungen und Video-Events
    // =======================================================================

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
    const injectPageScript = () => {
      const script = document.createElement('script');
      script.textContent = `
        // JP343 Debug-Funktionen im Page Context
        window.JP343_downloadLogs = function() {
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

    // Event-Listener und Script-Injection nur im Dev-Modus
    if (DEBUG_MODE) {
      // Event-Listener im Content Script Context
      window.addEventListener('JP343_REQUEST_LOGS', () => {
        const content = LOG_BUFFER.join('\n');
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `jp343-crunchyroll-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.log`;
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
        const observer = new MutationObserver(() => {
          if (document.head || document.documentElement) {
            injectPageScript();
            observer.disconnect();
          }
        });
        observer.observe(document, { childList: true, subtree: true });
      }
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
        videoIdFromUrl: window.location.pathname.match(/\/watch\/([A-Z0-9]+)/i)?.[1] || null,
        documentTitle: document.title,

        // Potentielle Ad-Elemente
        adDataTestidElements: Array.from(document.querySelectorAll('[data-testid*="ad"]')).map(el => ({
          tag: el.tagName,
          dataTestid: el.getAttribute('data-testid'),
          classes: el.className,
          visible: (el as HTMLElement).offsetParent !== null
        })),

        // Video-Container
        videoPlayer: !!document.querySelector('.video-player'),
        videoPlayerIframe: !!document.querySelector('.video-player iframe'),

        // Body Klassen
        bodyClasses: document.body.className,

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
              const dataTestid = node.getAttribute?.('data-testid');
              const classes = node.className || '';
              const ariaLabel = node.getAttribute?.('aria-label');

              // Logge interessante Elemente
              const isInteresting =
                dataTestid ||
                /ad|skip|overlay|countdown|player/i.test(classes) ||
                /ad|skip/i.test(ariaLabel || '');

              if (isInteresting) {
                debugLog('DOM_ADD', 'Neues Element hinzugefuegt', {
                  tag: node.tagName,
                  dataTestid: dataTestid,
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
              const dataTestid = node.getAttribute?.('data-testid');
              if (dataTestid && /ad|skip/i.test(dataTestid)) {
                debugLog('DOM_REMOVE', 'Element entfernt', {
                  tag: node.tagName,
                  dataTestid: dataTestid
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
      observers.push(debugMutationObserver);

      debugLog('INIT', 'Debug Mutation Observer gestartet');
    }

    function findVideoElement(): HTMLVideoElement | null {
      // Primaer: Standard video Element
      return document.querySelector('video') as HTMLVideoElement
        ?? document.querySelector('#player0') as HTMLVideoElement
        ?? null;
    }

    // =======================================================================
    // WERBUNG ERKENNUNG
    // =======================================================================

    function isAdPlaying(): boolean {
      return false;
    }

    function handleAdStateChange(): void {
      const adPlaying = isAdPlaying();

      if (adPlaying && !isCurrentlyInAd) {
        // Werbung hat begonnen
        isCurrentlyInAd = true;
        debugLog('AD_STATE', '=== WERBUNG BEGINNT ===', collectUIState());
        log('[JP343] Crunchyroll: Werbung beginnt');
        sendMessage('AD_START');
      } else if (!adPlaying && isCurrentlyInAd) {
        // Werbung ist beendet
        isCurrentlyInAd = false;
        debugLog('AD_STATE', '=== WERBUNG BEENDET ===', collectUIState());
        log('[JP343] Crunchyroll: Werbung beendet');
        sendMessage('AD_END');

        // Falls wir auf ein Video gewartet haben, jetzt starten
        if (pendingVideoId) {
          debugLog('AD_STATE', 'Starte gemerkte Session', { pendingVideoId });
          log('[JP343] Crunchyroll: Starte gemerkte Session nach Werbe-Ende');
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
    intervalIds.push(setInterval(handleAdStateChange, 500));

    // DEBUG: Periodisch alle 5 Sekunden vollstaendigen State loggen (nur wenn Video laeuft)
    if (DEBUG_MODE) {
      intervalIds.push(setInterval(() => {
        const video = findVideoElement();
        if (video && !video.paused) {
          debugLog('PERIODIC', 'Periodischer State-Check', collectUIState());
        }
      }, 5000));
    }

    // =======================================================================
    // CRUNCHYROLL METADATA-EXTRAKTION
    // =======================================================================

    function extractCrunchyrollMetadata(): CrunchyrollMetadata {
      const metadata: CrunchyrollMetadata = {
        title: 'Crunchyroll Content',
        episodeTitle: null,
        seasonNumber: null,
        episodeNumber: null,
        thumbnailUrl: null,
        seriesName: null
      };

      // Pruefen ob wir im iframe sind
      const isIframe = window !== window.top;
      let docTitle = document.title;

      // Im iframe: Versuche Titel vom Parent zu holen
      if (isIframe) {
        // 1. Priorität: Cached title vom postMessage
        if (cachedTitleFromParent) {
          docTitle = cachedTitleFromParent;
        } else {
          // 2. Fallback: Versuche direkt zuzugreifen (wird bei Cross-Origin fehlschlagen)
          try {
            docTitle = window.parent.document.title;
          } catch (e) {
            // Cross-origin - nutze lokalen Titel als Fallback
          }
        }
      }

      // 1. PRIMAER: Document Title
      // Crunchyroll setzt: "Episode Title - Watch on Crunchyroll" oder "Anime Title - Crunchyroll"
      const isGenericTitle = !docTitle ||
        docTitle.toLowerCase() === 'crunchyroll' ||
        docTitle.toLowerCase().includes('crunchyroll home');

      if (!isGenericTitle) {
        const cleanTitle = docTitle
          .replace(/\s*[-–—|]\s*(?:\S+\s+){0,3}Crunchyroll\b.*$/i, '')
          .trim();

        if (cleanTitle && cleanTitle.length > 0 && cleanTitle.toLowerCase() !== 'crunchyroll') {
          const parsed = parseCrunchyrollTitle(cleanTitle);
          Object.assign(metadata, parsed);
          // Besten Titel merken
          if (metadata.title !== 'Crunchyroll Content') {
            bestKnownTitle = metadata.title;
          }
        }
      }

      // Wenn document.title nur "Crunchyroll" ist, nutze gespeicherten besten Titel
      if (metadata.title === 'Crunchyroll Content' && bestKnownTitle) {
        metadata.title = bestKnownTitle;
      }

      // 2. OPTIONAL: OpenGraph meta tag (meist vorhanden)
      if (metadata.title === 'Crunchyroll Content') {
        const ogTitle = document.querySelector('meta[property="og:title"]');
        if (ogTitle) {
          const content = ogTitle.getAttribute('content');
          if (content) {
            const parsed = parseCrunchyrollTitle(content);
            Object.assign(metadata, parsed);
          }
        }
      }

      // 3. Episode-Text als Fallback
      if (isIframe && cachedEpisodeTextFromParent) {
        const epMatch = cachedEpisodeTextFromParent.match(/^E(\d+)\s*[-–]\s*(.+)$/i);
        if (epMatch) {
          const epNum = parseInt(epMatch[1], 10);
          const epTitle = epMatch[2].trim();
          metadata.episodeNumber = epNum;
          metadata.episodeTitle = epTitle;
          // Behalte seriesName vom document.title, aber aktualisiere Episode-Info
          log('[JP343] Episode aus DOM: E' + epNum + ' - ' + epTitle);
        }
      }

      // 4. Thumbnail aus OpenGraph oder andere Quellen
      // Im iframe: Nutze gecachtes Thumbnail vom Parent (falls vorhanden)
      if (isIframe && cachedThumbnailFromParent) {
        metadata.thumbnailUrl = cachedThumbnailFromParent;
      } else {
        metadata.thumbnailUrl = extractThumbnail();
      }

      return metadata;
    }

    function parseCrunchyrollTitle(rawTitle: string): Partial<CrunchyrollMetadata> {
      const result: Partial<CrunchyrollMetadata> = {
        title: rawTitle,
        seriesName: rawTitle  // Default: Titel ist auch Serienname
      };

      let match;

      // Pattern 1: "SeriesName - Staffel/Season N: SeasonName (EpRange) EpisodeTitle"
      // Beispiel: "Naruto - Staffel 4: Die Suche nach Tsunade (79-104) Verschwörung im Verborgenen"
      match = rawTitle.match(/^(.+?)\s*[-–]\s*(?:Staffel|Season)\s*(\d+)(?::\s*[^(]+?)?\s*\(\d+[-–]\d+\)\s+(.+)$/i);
      if (match) {
        result.seriesName = match[1].trim();
        result.title = match[1].trim();
        result.seasonNumber = parseInt(match[2], 10);
        result.episodeTitle = match[3].trim();
        return result;
      }

      // Pattern 2: "SeriesName - Staffel/Season N: SeasonName EpisodeTitle" (ohne EpRange)
      // Beispiel: "Naruto - Staffel 4: Die Suche nach Tsunade"
      match = rawTitle.match(/^(.+?)\s*[-–]\s*(?:Staffel|Season)\s*(\d+)(?::\s*(.+))?$/i);
      if (match) {
        result.seriesName = match[1].trim();
        result.title = match[1].trim();
        result.seasonNumber = parseInt(match[2], 10);
        if (match[3]) {
          result.episodeTitle = match[3].trim();
        }
        return result;
      }

      // Pattern 3: "SeriesName - ArcName (EpRange) EpisodeTitle"
      // Beispiel: "One Piece - East Blue (1-61) Hier kommt Ruffy"
      match = rawTitle.match(/^(.+?)\s*[-–]\s*.+?\s*\(\d+[-–]\d+\)\s+(.+)$/i);
      if (match) {
        result.seriesName = match[1].trim();
        result.title = match[1].trim();
        result.episodeTitle = match[2].trim();
        return result;
      }

      // Pattern 4: "SeriesName EpisodeTitle" (einfacher Titel mit erkennbarem Trenner)
      // Beispiel: "Hell's Paradise Der Todeskandidat und die Scharfrichterin"
      // Kein Trenner erkennbar - bleibt als Ganzes

      // Pattern 5: "Anime Name - Episode X - Title" oder "Anime Name - E1 - Title"
      match = rawTitle.match(/^(.+?)\s*[-–]\s*(?:Episode\s*)?(\d+)\s*[-–]\s*(.+)$/i);
      if (match) {
        result.seriesName = match[1].trim();
        result.title = match[1].trim();
        result.episodeNumber = parseInt(match[2], 10);
        result.episodeTitle = match[3].trim();
        return result;
      }

      // Pattern 6: "E1 - Title" (ohne Serienname)
      match = rawTitle.match(/^E(\d+)\s*[-–]\s*(.+)$/i);
      if (match) {
        result.episodeNumber = parseInt(match[1], 10);
        result.episodeTitle = match[2].trim();
        result.title = `Episode ${result.episodeNumber}: ${result.episodeTitle}`;
        return result;
      }

      // Pattern 7: "Season X Episode Y" irgendwo im Titel (EN)
      match = rawTitle.match(/Season\s*(\d+)\s*Episode\s*(\d+)/i);
      if (match) {
        result.seasonNumber = parseInt(match[1], 10);
        result.episodeNumber = parseInt(match[2], 10);
        const titlePart = rawTitle.substring(0, rawTitle.indexOf(match[0])).trim();
        if (titlePart) {
          result.seriesName = titlePart.replace(/[-–:]\s*$/, '').trim();
          result.title = titlePart.replace(/[-–:]\s*$/, '').trim();
        }
        return result;
      }

      // Pattern 8: "S1:E5" oder "S1 E5"
      match = rawTitle.match(/S(\d+)[:\s]*E(\d+)/i);
      if (match) {
        result.seasonNumber = parseInt(match[1], 10);
        result.episodeNumber = parseInt(match[2], 10);
        const titlePart = rawTitle.substring(0, rawTitle.indexOf(match[0])).trim();
        if (titlePart) {
          result.seriesName = titlePart.replace(/[-–:]\s*$/, '').trim();
          result.title = titlePart.replace(/[-–:]\s*$/, '').trim();
        }
        return result;
      }

      return result;
    }

    function extractThumbnail(): string | null {
      // 1. OpenGraph meta tag (Standard-Praxis, wahrscheinlich vorhanden)
      const ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage) {
        const content = ogImage.getAttribute('content');
        if (content) return content;
      }

      // 2. Weitere Selektoren nach Live-Test ergaenzen
      // (z.B. Poster-Images, Background-Images etc.)

      return null;
    }

    // =======================================================================
    // FORMATIERTER TITEL FUER TRACKING
    // =======================================================================

    function getFormattedTitle(): string {
      const metadata = extractCrunchyrollMetadata();
      cachedMetadata = metadata;

      // Format: "Anime Name S1E5: Episode Title" oder "Anime Name S4: Episode Title"
      let formatted = metadata.title;

      if (metadata.seasonNumber && metadata.episodeNumber) {
        formatted = `${metadata.seriesName || metadata.title} S${metadata.seasonNumber}E${metadata.episodeNumber}`;
      } else if (metadata.seasonNumber) {
        formatted = `${metadata.seriesName || metadata.title} S${metadata.seasonNumber}`;
      } else if (metadata.episodeNumber) {
        formatted = `${metadata.seriesName || metadata.title} E${metadata.episodeNumber}`;
      }

      if (metadata.episodeTitle) {
        formatted += `: ${metadata.episodeTitle}`;
      }

      return formatted;
    }

    // Cached Video-ID, Titel, Thumbnail, URL und Episode-Text im iframe (vom Parent via postMessage)
    let cachedVideoIdInIframe: string | null = null;
    let cachedTitleFromParent: string | null = null;
    let cachedThumbnailFromParent: string | null = null;
    let cachedEpisodeTextFromParent: string | null = null;
    let cachedWatchUrlFromParent: string | null = null;

    function getVideoId(): string | null {
      // Pruefen ob wir im iframe sind
      const isIframe = window !== window.top;

      if (isIframe) {
        // Cache nutzen falls bereits gefunden
        if (cachedVideoIdInIframe) {
          return cachedVideoIdInIframe;
        }

        // Im iframe: Video-ID aus frameElement-Attribut lesen
        try {
          const videoIdFromAttr = window.frameElement?.getAttribute('data-jp343-video-id');
          if (videoIdFromAttr) {
            log('[JP343] iframe: Video-ID aus Attribut gefunden:', videoIdFromAttr);
            cachedVideoIdInIframe = videoIdFromAttr;
            return videoIdFromAttr;
          }
        } catch (e) {
          log('[JP343] iframe: Kein Zugriff auf frameElement');
        }

        // Fallback: Versuche Parent-URL
        try {
          const parentUrl = window.parent.location.href;
          const match = parentUrl.match(/\/watch\/([A-Z0-9]+)/i);
          if (match) {
            log('[JP343] iframe: Video-ID vom Parent via location:', match[1]);
            cachedVideoIdInIframe = match[1];
            return match[1];
          }
        } catch (e) {
          // Cross-origin restriction - versuche document.referrer
          if (document.referrer) {
            const match = document.referrer.match(/\/watch\/([A-Z0-9]+)/i);
            if (match) {
              log('[JP343] iframe: Video-ID vom Parent via referrer:', match[1]);
              cachedVideoIdInIframe = match[1];
              return match[1];
            }
          }
        }

        // Noch nicht gefunden - wird spaeter nochmal versucht
        return null;
      }

      // Haupt-Frame: Eigene URL pruefen
      const match = window.location.pathname.match(/\/watch\/([A-Z0-9]+)/i);
      return match ? match[1] : null;
    }

    // Im iframe: Auf postMessage vom Parent lauschen
    if (window !== window.top) {
      window.addEventListener('message', (event) => {
        // Fix 3: Origin-Validierung bei postMessage
        if (event.origin && !event.origin.endsWith('.crunchyroll.com') && !event.origin.endsWith('.crunchyroll.co.jp')) {
          return;
        }
        // Prüfe ob es unsere Message ist
        if (event.data && event.data.type === 'JP343_VIDEO_ID') {
          const videoId = event.data.videoId;
          const title = event.data.title;
          const thumbnail = event.data.thumbnail;
          const episodeText = event.data.episodeText;
          const watchUrl = event.data.watchUrl;

          if (videoId) {
            // Setze Video-ID, Titel, Thumbnail, URL und Episode-Text
            const isFirstTime = !cachedVideoIdInIframe;
            const videoIdChanged = cachedVideoIdInIframe && cachedVideoIdInIframe !== videoId;
            cachedVideoIdInIframe = videoId;

            // Bei Video-Wechsel: bestKnownTitle zuruecksetzen (verhindert Cross-Show Bleed-Through)
            if (videoIdChanged) {
              resetForNewVideo();
              log('[JP343] iframe: Video-ID gewechselt, bestKnownTitle zurueckgesetzt');
            }

            if (title) {
              cachedTitleFromParent = title;
            }

            if (thumbnail) {
              cachedThumbnailFromParent = thumbnail;
            }

            if (watchUrl) {
              cachedWatchUrlFromParent = watchUrl;
            }

            // Episode-Text immer aktualisieren (kann sich bei Folgen-Wechsel aendern)
            if (episodeText) {
              cachedEpisodeTextFromParent = episodeText;
            }

            if (isFirstTime) {
              log('[JP343] iframe: Video-ID via postMessage empfangen:', videoId);
              if (title) {
                log('[JP343] iframe: Titel vom Parent empfangen:', title);
              }
              if (thumbnail) {
                log('[JP343] iframe: Thumbnail vom Parent empfangen');
              }
              if (episodeText) {
                log('[JP343] iframe: Episode-Text vom DOM:', episodeText);
              }
            }

            // Sende Bestätigung zurück an Parent (Fix 3: spezifischer Origin)
            if (window.parent && event.source) {
              (event.source as Window).postMessage({
                type: 'JP343_VIDEO_ID_ACK',
                videoId: videoId
              }, event.origin || 'https://www.crunchyroll.com');
            }
          }
        }
      });

      // Fallback: Periodisch nach Video-ID suchen falls postMessage nicht ankommt
      let retryCount = 0;
      const maxRetries = 20; // 20 x 200ms = 4 Sekunden
      const videoIdChecker = setInterval(() => {
        retryCount++;
        const videoId = getVideoId();
        if (videoId) {
          log('[JP343] iframe: Video-ID gefunden nach', retryCount, 'Versuchen:', videoId);
          clearInterval(videoIdChecker);
        } else if (retryCount >= maxRetries) {
          log('[JP343] iframe: Video-ID nicht gefunden nach', maxRetries, 'Versuchen - warte auf postMessage');
          clearInterval(videoIdChecker);
        }
      }, 200);
    }

    function getCurrentVideoState(): VideoState | null {
      const video = findVideoElement();
      if (!video) return null;

      const videoId = getVideoId();
      if (!videoId) return null;

      const metadata = cachedMetadata || extractCrunchyrollMetadata();

      const watchUrl = cachedWatchUrlFromParent || window.location.href;

      return {
        isPlaying: !video.paused && !video.ended,
        currentTime: video.currentTime,
        duration: video.duration || 0,
        title: getFormattedTitle(),
        url: watchUrl,
        platform: 'crunchyroll',
        isAd: isCurrentlyInAd || isAdPlaying(),
        thumbnailUrl: metadata.thumbnailUrl,
        videoId: videoId,
        // Crunchyroll: Serien-Name als Channel (fuer Block-Funktion + Gruppierung)
        // channelId = 'crunchyroll:<Serienname>' fuer Block-Support
        channelId: metadata.seriesName ? 'crunchyroll:' + metadata.seriesName : null,
        channelName: metadata.seriesName || null,
        channelUrl: null
      };
    }

    async function sendMessage(type: string, data?: Record<string, unknown>): Promise<void> {
      try {
        await browser.runtime.sendMessage({
          type,
          platform: 'crunchyroll',
          ...data
        });
      } catch (error) {
        log('[JP343] Message error:', error);
      }
    }

    function clearMetadataCache(): void {
      cachedMetadata = null;
    }

    // Vollstaendiger Reset fuer Video-Wechsel: verhindert dass alter Serienname
    // als channelName fuer das neue Video verwendet wird (Cross-Show Bleed-Through)
    function resetForNewVideo(): void {
      cachedMetadata = null;
      if (bestKnownTitle) {
        log('[JP343] Crunchyroll: bestKnownTitle bei Video-Wechsel zurueckgesetzt (war:', bestKnownTitle + ')');
        bestKnownTitle = '';
      }
    }

    function attachVideoEvents(video: HTMLVideoElement): void {
      if (video.hasAttribute('data-jp343-tracked')) {
        return;
      }
      video.setAttribute('data-jp343-tracked', 'true');

      video.addEventListener('play', () => {
        debugLog('VIDEO_PLAY', '=== VIDEO PLAY EVENT ===', collectUIState());

        // Metadata neu laden bei Play
        const videoId = getVideoId();
        // Bei neuem Video: vollstaendiger Reset inkl. bestKnownTitle
        if (videoId && lastVideoId && videoId !== lastVideoId) {
          resetForNewVideo();
        } else {
          clearMetadataCache();
        }

        // Bei Werbung: Video-ID merken, aber NICHT tracken
        if (isAdPlaying() || isCurrentlyInAd) {
          debugLog('VIDEO_PLAY', 'Play waehrend Werbung - wird ignoriert', { videoId, isCurrentlyInAd, isAdPlaying: isAdPlaying() });
          log('[JP343] Crunchyroll Play waehrend Werbung - wird ignoriert, Video-ID gemerkt:', videoId);
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
          log('[JP343] Crunchyroll Play:', state.title, '(ID:', lastVideoId, ')');
          sendMessage('VIDEO_PLAY', { state });
        }
      });

      video.addEventListener('pause', () => {
        debugLog('VIDEO_PAUSE', '=== VIDEO PAUSE EVENT ===', collectUIState());
        sendMessage('VIDEO_PAUSE');
      });

      video.addEventListener('ended', () => {
        debugLog('VIDEO_ENDED', '=== VIDEO ENDED EVENT ===', collectUIState());

        // Bei Werbung: NICHT VIDEO_ENDED senden
        if (isCurrentlyInAd) {
          debugLog('VIDEO_ENDED', 'Ended waehrend Werbung - wird ignoriert', { isCurrentlyInAd });
          log('[JP343] Crunchyroll Video ended waehrend Werbung - wird ignoriert');
          return;
        }
        sendMessage('VIDEO_ENDED');
        clearMetadataCache();
      });

      // loadedmetadata Event loggen
      video.addEventListener('loadedmetadata', () => {
        debugLog('VIDEO_META', '=== VIDEO LOADEDMETADATA ===', {
          duration: video.duration,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          ...collectUIState()
        });
      });

      // Seeking Events
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

          // Video-Wechsel NUR anhand der Video-ID erkennen
          if (currentVideoId && lastVideoId && currentVideoId !== lastVideoId) {
            log('[JP343] Crunchyroll Video-Wechsel (ID):', lastVideoId, '->', currentVideoId);
            lastVideoId = currentVideoId;
            lastTitle = state.title;
            resetForNewVideo();
            sendMessage('VIDEO_ENDED');
            setTimeout(() => {
              const newState = getCurrentVideoState();
              if (newState && newState.isPlaying && !isCurrentlyInAd) {
                sendMessage('VIDEO_PLAY', { state: newState });
              }
            }, 500);
          } else {
            // Nur Titel aktualisieren wenn wir einen guten haben
            if (state.title && state.title !== 'Crunchyroll Content') {
              lastTitle = state.title;
            }
            sendMessage('VIDEO_STATE_UPDATE', { state });
          }
        }
      }, 30000);

      log('[JP343] Crunchyroll Video Events gebunden');
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
          if (isAdPlaying() || isCurrentlyInAd) {
            debugLog('OBSERVER', 'Neues Video waehrend Werbung', { videoId });
            log('[JP343] Crunchyroll: Neues Video waehrend Werbung erkannt, ID gemerkt:', videoId);
            pendingVideoId = videoId;
            if (!isCurrentlyInAd) {
              isCurrentlyInAd = true;
              sendMessage('AD_START');
            }
          } else {
            // Kein Ad erkannt - sofort tracken
            log('[JP343] Crunchyroll: Neues Video laeuft bereits');
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
    observers.push(observer);

    const initialVideo = findVideoElement();
    if (initialVideo) {
      currentVideoElement = initialVideo;
      attachVideoEvents(initialVideo);
      const videoId = getVideoId();

      // Falls Video bereits laeuft
      if (!initialVideo.paused && !initialVideo.ended && videoId) {
        if (isAdPlaying()) {
          log('[JP343] Crunchyroll: Video laeuft bereits waehrend Werbung');
          isCurrentlyInAd = true;
          pendingVideoId = videoId;
          sendMessage('AD_START');
        } else {
          log('[JP343] Crunchyroll: Video laeuft bereits, starte Tracking');
          lastVideoId = videoId;
          lastTitle = getFormattedTitle();
          const state = getCurrentVideoState();
          if (state) {
            sendMessage('VIDEO_PLAY', { state });
          }
        }
      }
    }

    // URL-Wechsel erkennen (React SPA Navigation)
    let lastUrl = window.location.href;
    intervalIds.push(setInterval(() => {
      if (window.location.href !== lastUrl) {
        const oldUrl = lastUrl;
        const newUrl = window.location.href;
        const wasOnWatch = oldUrl.includes('/watch/');
        const isOnWatch = newUrl.includes('/watch/');

        debugLog('URL_CHANGE', '=== URL WECHSEL ===', {
          oldUrl, newUrl, wasOnWatch, isOnWatch,
          ...collectUIState()
        });
        log('[JP343] Crunchyroll URL-Wechsel:', oldUrl, '->', newUrl);
        lastUrl = newUrl;

        // Weg von /watch/: Session beenden
        if (wasOnWatch && !isOnWatch) {
          log('[JP343] Crunchyroll: /watch/ verlassen - Session beenden');
          sendMessage('VIDEO_ENDED');
          resetForNewVideo();
          return;
        }

        resetForNewVideo();

        // Nur auf /watch/ URLs neue Videos suchen
        if (isOnWatch) {
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
      }
    }, 1000));

    // Title-Observer: Crunchyroll setzt Titel manchmal verzoegert
    const titleObserver = new MutationObserver(() => {
      const docTitle = document.title;
      if (docTitle && docTitle.toLowerCase() !== 'crunchyroll' && !docTitle.toLowerCase().includes('home')) {
        const cleanTitle = docTitle
          .replace(/\s*[-–—|]\s*(?:\S+\s+){0,3}Crunchyroll\b.*$/i, '')
          .trim();
        if (cleanTitle && cleanTitle.length > 2 && cleanTitle.toLowerCase() !== 'crunchyroll') {
          if (cleanTitle !== bestKnownTitle) {
            log('[JP343] Crunchyroll: Neuer Titel erkannt:', cleanTitle);
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
      observers.push(titleObserver);
    }

    // Periodisch Titel pruefen (alle 5 Sekunden fuer die ersten 30 Sekunden)
    let titleCheckCount = 0;
    const titleCheckInterval = setInterval(() => {
      titleCheckCount++;
      const docTitle = document.title;
      if (docTitle && docTitle.toLowerCase() !== 'crunchyroll') {
        const cleanTitle = docTitle
          .replace(/\s*[-|–]\s*Watch on Crunchyroll.*$/i, '')
          .replace(/\s*[-|–]\s*Crunchyroll.*$/i, '')
          .trim();
        if (cleanTitle && cleanTitle.length > 2 && cleanTitle !== bestKnownTitle) {
          log('[JP343] Crunchyroll: Titel gefunden (Check #' + titleCheckCount + '):', cleanTitle);
          bestKnownTitle = cleanTitle;
          clearMetadataCache();
        }
      }
      // Nach 30 Sekunden aufhoeren
      if (titleCheckCount >= 6) {
        clearInterval(titleCheckInterval);
      }
    }, 5000);
    intervalIds.push(titleCheckInterval);

    // Debug: Zeige Status nach 3 Sekunden
    setTimeout(() => {
      const video = findVideoElement();
      const videoId = getVideoId();
      const metadata = extractCrunchyrollMetadata();
      const adPlaying = isAdPlaying();
      log('[JP343] Crunchyroll Debug:', {
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
          log('[JP343] Crunchyroll: Starte verzoegertes Tracking');
          lastVideoId = videoId;
          lastTitle = state.title;
          sendMessage('VIDEO_PLAY', { state });
        }
      } else if (video && !video.paused && (adPlaying || isCurrentlyInAd) && videoId) {
        log('[JP343] Crunchyroll: Video laeuft waehrend Werbung - Tracking pausiert');
        pendingVideoId = videoId;
      }
    }, 3000);

    // PAUSE_VIDEO: Video pausieren wenn "Stop & Save" geklickt wird
    browser.runtime.onMessage.addListener((message) => {
      if (message?.type === 'PAUSE_VIDEO' && currentVideoElement) {
        currentVideoElement.pause();
      }
      if (message?.type === 'RESUME_VIDEO' && currentVideoElement) {
        currentVideoElement.play();
      }
    });
  }
});
