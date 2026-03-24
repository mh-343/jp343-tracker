// =============================================================================
// JP343 Extension - Amazon Prime Video Content Script
// =============================================================================

import type { VideoState } from '../../types';

// Metadata fuer Prime Video
interface PrimeVideoMetadata {
  title: string;
  episodeTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  isMovie: boolean;
  thumbnailUrl: string | null;
}

export default defineContentScript({
  matches: [
    '*://*.primevideo.com/*',
    // Breite Patterns - Content Script prueft intern ob es eine Watch-Seite ist
    '*://*.amazon.com/*',
    '*://*.amazon.de/*',
    '*://*.amazon.co.jp/*',
    '*://*.amazon.co.uk/*',
    '*://*.amazon.fr/*',
    '*://*.amazon.es/*',
    '*://*.amazon.it/*',
    '*://*.amazon.ca/*',
    '*://*.amazon.com.au/*',
    '*://*.amazon.in/*',
    '*://*.amazon.com.br/*'
  ],
  runAt: 'document_idle',

  main() {
    let currentVideoElement: HTMLVideoElement | null = null;
    let lastTitle: string = '';
    let lastVideoId: string | null = null;
    let bestKnownTitle: string = '';
    let isCurrentlyInAd: boolean = false;

    function findVideoElement(): HTMLVideoElement | null {
      return (document.querySelector('.dv-player-fullscreen video') as HTMLVideoElement)
        || (document.querySelector('[data-testid="web-player"] video') as HTMLVideoElement)
        || (document.querySelector('.webPlayerSDKContainer video') as HTMLVideoElement)
        || null;
    }


    function isPlayerActive(): boolean {
      return !!(document.querySelector('.dv-player-fullscreen')
        || document.querySelector('.webPlayerSDKContainer')
        || document.querySelector('[data-testid="web-player"]'));
    }

    // Cleanup-Registry
    const observers: MutationObserver[] = [];
    const intervalIds: ReturnType<typeof setInterval>[] = [];
    function cleanup(): void {
      observers.forEach(o => o.disconnect());
      intervalIds.forEach(clearInterval);
      observers.length = 0;
      intervalIds.length = 0;
    }
    // Bei Seitenverlassen: Session beenden + Cleanup
    window.addEventListener('pagehide', () => {
      if (lastVideoId) {
        log('[JP343] Prime Video: Seite wird verlassen - VIDEO_ENDED');
        sendMessage('VIDEO_ENDED');
      }
      cleanup();
    });
    window.addEventListener('beforeunload', () => {
      if (lastVideoId) {
        log('[JP343] Prime Video: beforeunload - VIDEO_ENDED');
        sendMessage('VIDEO_ENDED');
      }
    });

    const DEBUG_MODE = import.meta.env.DEV;
    const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};
    log('[JP343] Prime Video Content Script geladen');
    const LOG_BUFFER: string[] = [];
    const MAX_LOG_ENTRIES = 5000;

    function debugLog(category: string, message: string, data?: Record<string, unknown>): void {
      if (!DEBUG_MODE) return;
      const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);
      const fullTimestamp = new Date().toISOString();
      const logLine = `[${fullTimestamp}] [${category}] ${message}`;
      console.log(`[JP343 DEBUG ${timestamp}] [${category}]`, message, data || '');
      const bufferEntry = data ? `${logLine} ${JSON.stringify(data)}` : logLine;
      LOG_BUFFER.push(bufferEntry);
      if (LOG_BUFFER.length > MAX_LOG_ENTRIES) LOG_BUFFER.shift();
    }

    // Debug-Funktionen in Page Context injizieren
    if (DEBUG_MODE) {
      const script = document.createElement('script');
      script.textContent = `
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

      window.addEventListener('JP343_REQUEST_LOGS', () => {
        const content = LOG_BUFFER.join('\n');
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `jp343-primevideo-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.log`;
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
      });
    }

    // Sammelt UI-State fuer Debug-Output
    function collectUIState(): Record<string, unknown> {
      const video = findVideoElement();
      return {
        videoExists: !!video,
        videoPaused: video?.paused ?? null,
        videoEnded: video?.ended ?? null,
        videoDuration: video?.duration ?? null,
        videoCurrentTime: video?.currentTime ?? null,
        url: window.location.href,
        videoIdFromUrl: getVideoId(),
        documentTitle: document.title,
        isCurrentlyInAd,
        lastVideoId,
        bestKnownTitle,
        adTimerVisible: !!document.querySelector('[data-testid="ad-timer"], .atvwebplayersdk-ad-timer, .adTimerText'),
        playerTitleEl: document.querySelector('[data-testid="title-text"], .atvwebplayersdk-title-text')?.textContent?.trim() || null,
        playerSubtitleEl: document.querySelector('[data-testid="subtitle-text"], .atvwebplayersdk-subtitle-text')?.textContent?.trim() || null,
        allDataTestIds: Array.from(document.querySelectorAll('[data-testid]'))
          .filter(el => (el as HTMLElement).offsetParent !== null)
          .slice(0, 30)
          .map(el => el.getAttribute('data-testid'))
      };
    }

    // DOM Mutation Observer fuer Debug
    if (DEBUG_MODE) {
      const debugMutationObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              const dataTestId = node.getAttribute?.('data-testid');
              const classes = node.className || '';
              const innerText = node.innerText?.slice(0, 50) || '';
              const isInteresting =
                dataTestId ||
                /ad|skip|interstitial|overlay|countdown|timer/i.test(classes) ||
                /Werbung|^Ad\s/i.test(innerText);
              if (isInteresting) {
                debugLog('DOM_ADD', 'Neues Element', {
                  tag: node.tagName,
                  dataTestId,
                  classes,
                  id: node.id,
                  innerText: node.innerText?.slice(0, 100),
                  visible: node.offsetParent !== null
                });
              }
            }
          });
          mutation.removedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              const dataTestId = node.getAttribute?.('data-testid');
              if (dataTestId && /ad|skip|interstitial/i.test(dataTestId)) {
                debugLog('DOM_REMOVE', 'Element entfernt', { tag: node.tagName, dataTestId });
              }
            }
          });
        });
      });
      debugMutationObserver.observe(document.body, { childList: true, subtree: true });
      observers.push(debugMutationObserver);
      debugLog('INIT', 'Debug Mutation Observer gestartet');

      // Periodischer State-Check (alle 5s wenn Video laeuft)
      intervalIds.push(setInterval(() => {
        const video = findVideoElement();
        if (video && !video.paused) {
          debugLog('PERIODIC', 'State-Check', collectUIState());
        }
      }, 5000));
    }

    // =======================================================================
    // URL + VIDEO ID ERKENNUNG
    // =======================================================================

    function isWatchPage(): boolean {
      const path = window.location.pathname;
      const search = window.location.search;
      const hostname = window.location.hostname;

      // primevideo.com: Player laeuft auf /detail/ Seiten
      if (hostname.includes('primevideo.com')) {
        return path.includes('/detail/') || path.includes('/dp/');
      }

      // amazon.*: Player auf /gp/video/detail/ Seiten
      if (hostname.includes('amazon.')) {
        return path.includes('/gp/video/detail/') || path.includes('/gp/video/dp/');
      }

      return false;
    }

    function getVideoId(): string | null {
      const path = window.location.pathname;

      // ID aus URL extrahieren (ASIN = 10 Zeichen, aber Amazon nutzt auch laengere IDs)
      // Patterns: /detail/<ID>/, /dp/<ID>/, /gp/video/detail/<ID>/
      const asinMatch = path.match(/\/(?:detail|dp)\/([A-Z0-9]{10,})/i);
      return asinMatch ? asinMatch[1] : null;
    }

    // =======================================================================
    // TITEL-EXTRAKTION
    // =======================================================================

    // Generische/unbrauchbare Titel
    const GENERIC_TITLES = new Set([
      'prime video', 'amazon prime video', 'amazon prime',
      'filme und serien', 'movies and tv', 'movies & tv',
      'home', 'startseite', 'meine videos', 'my stuff',
      'store', 'categories', 'kategorien', 'channels'
    ]);

    function isGenericTitle(title: string): boolean {
      if (!title || title === 'Prime Video Content') return true;
      const lower = title.toLowerCase().trim();
      if (lower.length < 2) return true;
      return GENERIC_TITLES.has(lower);
    }

    function extractMetadata(): PrimeVideoMetadata {
      const metadata: PrimeVideoMetadata = {
        title: 'Prime Video Content',
        episodeTitle: null,
        seasonNumber: null,
        episodeNumber: null,
        isMovie: true,
        thumbnailUrl: null
      };

      // 1. Document Title
      const docTitle = document.title;
      if (!isGenericTitle(docTitle)) {
        const cleanTitle = docTitle
          .replace(/\s*[\|–-]\s*(?:Prime Video|Amazon Prime Video|Amazon\.?\w*).*$/i, '')
          .replace(/^(?:Amazon\.\w+:\s*)/i, '')
          .replace(/\s*[-–]\s*(?:Staffel|Season|Temporada|Saison)\s+\d+\s+ansehen$/i, '')
          .replace(/\s+ansehen$|\s+anschauen$/i, '')
          .replace(/^(?:Watch|Ansehen|Regarder|Ver|Guarda)\s+/i, '')
          .trim();
        if (cleanTitle && cleanTitle.length > 0 && !isGenericTitle(cleanTitle)) {
          const parsed = parsePrimeTitle(cleanTitle);
          Object.assign(metadata, parsed);
          if (metadata.title !== 'Prime Video Content' && !isGenericTitle(metadata.title)) {
            bestKnownTitle = metadata.title;
          }
        }
      }

      // Fallback: gespeicherter bester Titel
      if (metadata.title === 'Prime Video Content' && bestKnownTitle && !isGenericTitle(bestKnownTitle)) {
        metadata.title = bestKnownTitle;
      }

      // 2. Player-UI Titel (data-testid basiert)
      tryExtractPlayerTitle(metadata);

      // 3. Thumbnail
      metadata.thumbnailUrl = extractThumbnail();

      return metadata;
    }

    function tryExtractPlayerTitle(metadata: PrimeVideoMetadata): void {
      const titleSelectors = [
        '[data-testid="title-text"]',
        '[data-testid="video-title"]',
        '.atvwebplayersdk-title-text',
        '.dv-player-fullscreen .title',
        '.dv-dp-node-title',
        '.av-detail-section .dv-node-dp-title',
        // Generischer Fallback
        'h1[data-automation-id="title"]'
      ];

      for (const selector of titleSelectors) {
        const el = document.querySelector(selector);
        const text = el?.textContent?.trim();
        if (text && text.length > 1 && !isGenericTitle(text)) {
          metadata.title = text;
          bestKnownTitle = text;
          log('[JP343] Prime Video: Player-Titel gefunden via', selector, ':', text);
          break;
        }
      }

      // Episode-Info Selektoren
      const subtitleSelectors = [
        '[data-testid="subtitle-text"]',
        '.atvwebplayersdk-subtitle-text',
        '.dv-player-fullscreen .subtitle'
      ];

      for (const selector of subtitleSelectors) {
        const el = document.querySelector(selector);
        const text = el?.textContent?.trim();
        if (text && text.length > 1) {
          const epInfo = parseEpisodeInfo(text);
          if (epInfo.episodeNumber) {
            metadata.seasonNumber = epInfo.seasonNumber;
            metadata.episodeNumber = epInfo.episodeNumber;
            metadata.episodeTitle = epInfo.episodeTitle;
            metadata.isMovie = false;
            log('[JP343] Prime Video: Episode-Info gefunden:', text);
            break;
          }
        }
      }
    }

    function parsePrimeTitle(rawTitle: string): Partial<PrimeVideoMetadata> {
      const result: Partial<PrimeVideoMetadata> = {
        title: rawTitle,
        isMovie: true
      };

      // "Serienname - S1:E5 - Episodentitel"
      const sePattern = /^(.+?)\s*[-–]\s*S(\d+):?E(\d+)\s*[-–]?\s*(.*)$/i;
      let match = rawTitle.match(sePattern);
      if (match) {
        result.title = match[1].trim();
        result.seasonNumber = parseInt(match[2], 10);
        result.episodeNumber = parseInt(match[3], 10);
        result.episodeTitle = match[4].trim() || null;
        result.isMovie = false;
        return result;
      }

      // "Serienname - Season 1 Episode 5"
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

      // "Serienname - Staffel 1 Folge 5"
      const dePattern = /^(.+?)\s*[-–]\s*Staffel\s*(\d+).*Folge\s*(\d+)(.*)$/i;
      match = rawTitle.match(dePattern);
      if (match) {
        result.title = match[1].trim();
        result.seasonNumber = parseInt(match[2], 10);
        result.episodeNumber = parseInt(match[3], 10);
        result.episodeTitle = match[4].replace(/^[\s:–-]+/, '').trim() || null;
        result.isMovie = false;
        return result;
      }

      // S1E5 irgendwo im Titel
      const inlinePattern = /S(\d+)\s*E(\d+)/i;
      match = rawTitle.match(inlinePattern);
      if (match) {
        result.seasonNumber = parseInt(match[1], 10);
        result.episodeNumber = parseInt(match[2], 10);
        const titlePart = rawTitle.substring(0, rawTitle.indexOf(match[0])).trim();
        if (titlePart) {
          result.title = titlePart.replace(/[-–:]\s*$/, '').trim();
        }
        result.isMovie = false;
        return result;
      }

      return result;
    }

    function parseEpisodeInfo(text: string): {
      seasonNumber: number | null;
      episodeNumber: number | null;
      episodeTitle: string | null;
    } {
      const result = {
        seasonNumber: null as number | null,
        episodeNumber: null as number | null,
        episodeTitle: null as string | null
      };

      const patterns: [RegExp, boolean][] = [
        [/S(\d+)\s*[:\s]?\s*E(\d+)/i, true],          // S1E5, S1:E5
        [/Season\s*(\d+).*Episode\s*(\d+)/i, true],    // Season 1 Episode 5
        [/Staffel\s*(\d+).*Folge\s*(\d+)/i, true],     // Staffel 1 Folge 5
        [/(\d+)x(\d+)/, true],                          // 1x05
        [/Ep\.?\s*(\d+)/i, false],                      // Ep. 5 / Episode 5
        [/Folge\s*(\d+)/i, false],                      // Folge 5
        [/Episode\s*(\d+)/i, false]                     // Episode 5
      ];

      for (const [pattern, hasSeason] of patterns) {
        const match = text.match(pattern);
        if (match) {
          if (hasSeason && match[2]) {
            result.seasonNumber = parseInt(match[1], 10);
            result.episodeNumber = parseInt(match[2], 10);
          } else {
            result.episodeNumber = parseInt(match[1], 10);
          }
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
      // OG Image Meta Tag
      const ogImage = document.querySelector('meta[property="og:image"]') as HTMLMetaElement;
      if (ogImage?.content && ogImage.content.startsWith('https://')) {
        return ogImage.content;
      }

      // Poster-Bild auf der Detail-Seite
      const posterSelectors = [
        '[data-testid="packshot"] img',
        '.dv-dp-packshot img',
        '.av-dp-packshot img',
        '.dv-fallback-packshot img'
      ];

      for (const selector of posterSelectors) {
        const img = document.querySelector(selector) as HTMLImageElement;
        if (img?.src && img.src.startsWith('https://')) {
          return img.src;
        }
      }

      return null;
    }

    // =======================================================================
    // WERBUNG ERKENNUNG (Prime Video AVOD)
    // =======================================================================

    function isAdPlaying(): boolean {
      if (!isWatchPage()) return false;

      const adSelectors = [
        '.atvwebplayersdk-ad-timer-remaining-time',
        '[data-testid="ad-timer"]',
        '[data-testid="ad-badge"]',
        '[data-testid="ad-info"]',
        '.atvwebplayersdk-ad-timer',
        '.adTimerText',
        '.adBreakTimer',
        '.atvwebplayersdk-adtimerdisplay',
        '[class*="adBreak"]',
        '[class*="ad-break"]',
        '[class*="adTimer"]'
      ];

      for (const selector of adSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          const rect = element.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            log('[JP343] Prime Video: Ad erkannt via:', selector);
            return true;
          }
        }
      }

      // Text-basierte Erkennung: "Werbung 0:32" / "Ad 1 of 3" etc.
      // Suche im gesamten Body, nicht nur im Player-Container (Overlay kann ausserhalb liegen)
      const allElements = document.querySelectorAll('span, div, p, [class*="ad"], [class*="Ad"]');
      for (const el of allElements) {
        const text = (el as HTMLElement).innerText?.trim();
        if (!text || text.length > 40) continue;
        // "Werbung 0:32", "Ad 2 of 3", "Ad 0:15", "Publicité 0:20", "広告 0:15"
        if (/^(?:Werbung|Ad|Ads|Publicité|Anuncio|Pubblicità|Reclame|Annonce|広告|광고|Реклама)\s+\d/i.test(text)) {
          const isVisible = (el as HTMLElement).offsetParent !== null;
          if (isVisible) {
            log('[JP343] Prime Video: Ad erkannt via Text:', text);
            return true;
          }
        }
      }

      // Breitere Klassen-Suche: Alle Elemente mit "ad" im class-Namen die sichtbar sind
      const adClassElements = document.querySelectorAll('[class*="adBreak"], [class*="adTimer"], [class*="ad-timer"], [class*="adOverlay"], [class*="AdSlot"], [class*="ad-slot"]');
      for (const el of adClassElements) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          log('[JP343] Prime Video: Ad erkannt via Klasse:', el.className);
          return true;
        }
      }

      return false;
    }

    function handleAdStateChange(): void {
      const adPlaying = isAdPlaying();

      if (adPlaying && !isCurrentlyInAd) {
        isCurrentlyInAd = true;
        log('[JP343] Prime Video: Werbung beginnt');
        sendMessage('AD_START');
      } else if (!adPlaying && isCurrentlyInAd) {
        isCurrentlyInAd = false;
        log('[JP343] Prime Video: Werbung beendet');
        sendMessage('AD_END');
      }
    }

    // Ad-Status alle 500ms pruefen
    intervalIds.push(setInterval(handleAdStateChange, 500));

    // =======================================================================
    // FORMATIERTER TITEL + VIDEO STATE
    // =======================================================================

    function getFormattedTitle(): string {
      const metadata = extractMetadata();

      if (metadata.isMovie) {
        return metadata.title;
      }

      let formatted = metadata.title;
      if (metadata.seasonNumber && metadata.episodeNumber) {
        formatted += ` S${metadata.seasonNumber}E${metadata.episodeNumber}`;
      } else if (metadata.episodeNumber) {
        formatted += ` E${metadata.episodeNumber}`;
      }
      if (metadata.episodeTitle) {
        formatted += `: ${metadata.episodeTitle}`;
      }
      return formatted;
    }

    function getCurrentVideoState(): VideoState | null {
      const video = findVideoElement();
      if (!video) return null;

      const videoId = getVideoId();
      if (!videoId) return null;

      const metadata = extractMetadata();

      return {
        isPlaying: !video.paused && !video.ended,
        currentTime: video.currentTime,
        duration: video.duration || 0,
        title: getFormattedTitle(),
        url: window.location.href,
        platform: 'primevideo',
        isAd: isCurrentlyInAd || isAdPlaying(),
        thumbnailUrl: metadata.thumbnailUrl,
        videoId: videoId,
        // Titel als Channel (fuer Block-Funktion) - immer setzen, nicht nur fuer Serien
        // Prime Video zeigt oft keinen Episoden-Info, trotzdem soll Block moeglich sein
        channelId: (metadata.title !== 'Prime Video Content')
          ? 'primevideo:' + metadata.title : null,
        channelName: (metadata.title !== 'Prime Video Content')
          ? metadata.title : null,
        channelUrl: null
      };
    }

    // =======================================================================
    // MESSAGING
    // =======================================================================

    async function sendMessage(type: string, data?: Record<string, unknown>): Promise<void> {
      try {
        await browser.runtime.sendMessage({
          type,
          platform: 'primevideo',
          ...data
        });
      } catch (error) {
        log('[JP343] Prime Video: Message error:', error);
      }
    }

    // =======================================================================
    // VIDEO EVENT BINDING
    // =======================================================================

    function attachVideoEvents(video: HTMLVideoElement): void {
      if (video.hasAttribute('data-jp343-tracked')) return;
      video.setAttribute('data-jp343-tracked', 'true');

      video.addEventListener('play', () => {
        debugLog('VIDEO_PLAY', '=== VIDEO PLAY EVENT ===', collectUIState());

        if (!isWatchPage()) {
          log('[JP343] Prime Video: Play auf Nicht-Watch-Seite ignoriert');
          return;
        }

        if (isAdPlaying() || isCurrentlyInAd) {
          debugLog('VIDEO_PLAY', 'Play waehrend Werbung ignoriert', { isCurrentlyInAd, isAdPlaying: isAdPlaying() });
          log('[JP343] Prime Video: Play waehrend Werbung ignoriert');
          if (!isCurrentlyInAd) {
            isCurrentlyInAd = true;
            sendMessage('AD_START');
          }
          return;
        }

        const videoId = getVideoId();
        // Bei neuem Video: bestKnownTitle zuruecksetzen
        if (videoId && lastVideoId && videoId !== lastVideoId) {
          bestKnownTitle = '';
        }

        const state = getCurrentVideoState();
        if (state) {
          if (isGenericTitle(state.title)) {
            log('[JP343] Prime Video: Generischer Titel - verzoegere...');
            // Retry-Logik fuer Titel
            let retryCount = 0;
            const titleRetry = setInterval(() => {
              retryCount++;
              const retryState = getCurrentVideoState();
              if (retryState && !isGenericTitle(retryState.title)) {
                clearInterval(titleRetry);
                lastVideoId = videoId;
                lastTitle = retryState.title;
                log('[JP343] Prime Video: Guter Titel nach Retry #' + retryCount + ':', retryState.title);
                sendMessage('VIDEO_PLAY', { state: retryState });
              } else if (retryCount >= 5) {
                clearInterval(titleRetry);
                if (retryState && retryState.isPlaying && !isCurrentlyInAd) {
                  lastVideoId = videoId;
                  lastTitle = retryState.title;
                  sendMessage('VIDEO_PLAY', { state: retryState });
                }
              }
            }, 2000);
            return;
          }

          lastVideoId = videoId;
          lastTitle = state.title;
          log('[JP343] Prime Video Play:', state.title);
          sendMessage('VIDEO_PLAY', { state });
        }
      });

      video.addEventListener('pause', () => {
        debugLog('VIDEO_PAUSE', '=== VIDEO PAUSE EVENT ===', collectUIState());
        if (isCurrentlyInAd) return;
        sendMessage('VIDEO_PAUSE');
      });

      video.addEventListener('ended', () => {
        debugLog('VIDEO_ENDED', '=== VIDEO ENDED EVENT ===', collectUIState());
        if (isCurrentlyInAd) {
          log('[JP343] Prime Video: ended waehrend Werbung ignoriert');
          return;
        }
        sendMessage('VIDEO_ENDED');
      });

      // Periodische Updates (alle 30 Sekunden)
      const updateInterval = setInterval(() => {
        if (isCurrentlyInAd || !isWatchPage()) return;

        const state = getCurrentVideoState();
        if (state && state.isPlaying) {
          const currentVideoId = getVideoId();

          // Video-Wechsel erkennen
          if (currentVideoId && lastVideoId && currentVideoId !== lastVideoId) {
            log('[JP343] Prime Video: Video-Wechsel:', lastVideoId, '->', currentVideoId);
            sendMessage('VIDEO_ENDED');
            bestKnownTitle = '';
            lastVideoId = currentVideoId;

            setTimeout(() => {
              const newState = getCurrentVideoState();
              if (newState && newState.isPlaying && !isCurrentlyInAd) {
                lastTitle = newState.title;
                sendMessage('VIDEO_PLAY', { state: newState });
              }
            }, 500);
          } else {
            if (state.title && state.title !== 'Prime Video Content') {
              lastTitle = state.title;
            }
            sendMessage('VIDEO_STATE_UPDATE', { state });
          }
        }
      }, 30000);
      intervalIds.push(updateInterval);

      // Schnelle Titel-Updates fuer die ersten 30s
      let quickUpdateCount = 0;
      const quickTitleUpdate = setInterval(() => {
        quickUpdateCount++;
        if (isCurrentlyInAd || video.paused) return;
        const state = getCurrentVideoState();
        if (state && state.isPlaying && !isGenericTitle(state.title) && state.title !== lastTitle) {
          log('[JP343] Prime Video: Titel-Update (quick #' + quickUpdateCount + '):', state.title);
          lastTitle = state.title;
          sendMessage('VIDEO_STATE_UPDATE', { state });
        }
        if (quickUpdateCount >= 6) clearInterval(quickTitleUpdate);
      }, 5000);
      intervalIds.push(quickTitleUpdate);

      log('[JP343] Prime Video: Events gebunden');
    }

    // =======================================================================
    // VIDEO ELEMENT OBSERVER
    // =======================================================================

    // MutationObserver: Sucht nach neuen Video-Elementen + erkennt Player-Close
    const observer = new MutationObserver(() => {
      // Player-Close erkennen: Wenn wir ein Video hatten aber der Player jetzt weg ist
      if (currentVideoElement && lastVideoId && !isPlayerActive()) {
        log('[JP343] Prime Video: Player geschlossen - Session beenden');
        sendMessage('VIDEO_ENDED');
        currentVideoElement = null;
        bestKnownTitle = '';
        lastVideoId = null;
        lastTitle = '';
        return;
      }

      if (!isWatchPage()) return;

      const video = findVideoElement();
      if (video && video !== currentVideoElement) {
        currentVideoElement = video;
        attachVideoEvents(video);
        const videoId = getVideoId();

        // Falls Video bereits laeuft
        if (!video.paused && !video.ended && videoId) {
          if (isAdPlaying() || isCurrentlyInAd) {
            log('[JP343] Prime Video: Neues Video waehrend Werbung');
            if (!isCurrentlyInAd) {
              isCurrentlyInAd = true;
              sendMessage('AD_START');
            }
          } else {
            log('[JP343] Prime Video: Video laeuft bereits');
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

    observer.observe(document.body, { childList: true, subtree: true });
    observers.push(observer);

    // Initiales Video suchen
    if (isWatchPage()) {
      const initialVideo = findVideoElement();
      if (initialVideo) {
        currentVideoElement = initialVideo;
        attachVideoEvents(initialVideo);
        const videoId = getVideoId();

        if (!initialVideo.paused && !initialVideo.ended && videoId) {
          if (isAdPlaying()) {
            isCurrentlyInAd = true;
            sendMessage('AD_START');
          } else {
            lastVideoId = videoId;
            lastTitle = getFormattedTitle();
            const state = getCurrentVideoState();
            if (state) {
              log('[JP343] Prime Video: Initiales Video laeuft');
              sendMessage('VIDEO_PLAY', { state });
            }
          }
        }
      }
    }

    // =======================================================================
    // SPA NAVIGATION (URL Polling)
    // =======================================================================

    let lastUrl = window.location.href;
    intervalIds.push(setInterval(() => {
      if (window.location.href !== lastUrl) {
        const oldUrl = lastUrl;
        const newUrl = window.location.href;
        const wasOnWatch = oldUrl.includes('/detail/') || oldUrl.includes('/dp/') || oldUrl.includes('/gp/video/detail/');
        const isOnWatch = isWatchPage();

        debugLog('URL_CHANGE', '=== URL WECHSEL ===', { oldUrl, newUrl, wasOnWatch, isOnWatch, ...collectUIState() });
        log('[JP343] Prime Video: URL-Wechsel:', oldUrl, '->', newUrl);
        lastUrl = newUrl;

        // Weg von Watch-Seite: Session beenden
        if (wasOnWatch && !isOnWatch) {
          log('[JP343] Prime Video: Watch-Seite verlassen');
          sendMessage('VIDEO_ENDED');
          bestKnownTitle = '';
          return;
        }

        bestKnownTitle = '';

        // Neue Watch-Seite: Video suchen
        if (isOnWatch) {
          setTimeout(() => {
            const video = findVideoElement();
            if (video && video !== currentVideoElement) {
              currentVideoElement = video;
              attachVideoEvents(video);
              lastVideoId = getVideoId();
              lastTitle = getFormattedTitle();
            }
          }, 1000);
        }
      }
    }, 1000));

    // Title-Observer: Titel wird manchmal verzoegert gesetzt
    const titleElement = document.querySelector('title');
    if (titleElement) {
      const titleObserver = new MutationObserver(() => {
        const docTitle = document.title;
        if (docTitle && !isGenericTitle(docTitle)) {
          const cleanTitle = docTitle
            .replace(/\s*[\|–-]\s*(?:Prime Video|Amazon Prime Video|Amazon\.?\w*).*$/i, '')
            .replace(/^(?:Watch|Ansehen)\s+/i, '')
            .trim();
          if (cleanTitle && cleanTitle.length > 2 && !isGenericTitle(cleanTitle) && cleanTitle !== bestKnownTitle) {
            if (isWatchPage()) {
              log('[JP343] Prime Video: Neuer Titel erkannt:', cleanTitle);
              bestKnownTitle = cleanTitle;
            }
          }
        }
      });
      titleObserver.observe(titleElement, { childList: true, characterData: true, subtree: true });
      observers.push(titleObserver);
    }

    // Fallback: Falls Video laeuft aber nicht getrackt wird (nach 3s)
    setTimeout(() => {
      if (!isWatchPage()) return;
      const video = findVideoElement();
      const videoId = getVideoId();
      if (video && !video.paused && !video.ended && videoId && !isAdPlaying() && !isCurrentlyInAd) {
        const state = getCurrentVideoState();
        if (state && !isGenericTitle(state.title)) {
          log('[JP343] Prime Video: Starte verzoegertes Tracking');
          lastVideoId = videoId;
          lastTitle = state.title;
          sendMessage('VIDEO_PLAY', { state });
        }
      }
    }, 3000);

    // PAUSE_VIDEO / RESUME_VIDEO: Steuerung vom Popup
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
