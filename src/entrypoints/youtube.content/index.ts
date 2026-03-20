// =============================================================================
// JP343 Extension - YouTube Content Script
// Erkennt Video-Playback und Werbung auf YouTube
// =============================================================================

import type { VideoState } from '../../types';

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',

  main() {
    let currentVideoElement: HTMLVideoElement | null = null;
    let lastVideoUrl: string | null = null;
    let isCurrentlyAd = false;
    let adCheckInterval: ReturnType<typeof setInterval> | null = null;
    let stateUpdateInterval: ReturnType<typeof setInterval> | null = null;
    let extensionContextValid = true;

    // Cleanup-Registry (Fix 4+5)
    const observers: MutationObserver[] = [];
    const intervalIds: ReturnType<typeof setInterval>[] = [];
    function cleanup(): void {
      observers.forEach(o => o.disconnect());
      intervalIds.forEach(clearInterval);
      observers.length = 0;
      intervalIds.length = 0;
    }
    // pagehide statt unload: YouTube blockiert unload via Permissions Policy
    window.addEventListener('pagehide', cleanup);

    // =======================================================================
    // DEBUG LOGGING - Erfasst alle DOM-Aenderungen und Video-Events
    // =======================================================================

    const DEBUG_MODE = import.meta.env.DEV;  // true in Dev, false in Prod (Fix 11)
    const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};
    log('[JP343] YouTube Content Script geladen');
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

    // Debug-Befehle via postMessage (umgeht YouTube CSP)
    // In der Console eingeben: window.postMessage({type:'JP343_DOWNLOAD_LOGS'})
    // Oder: window.postMessage({type:'JP343_CLEAR_LOGS'})
    // Oder: window.postMessage({type:'JP343_LOG_STATUS'})
    if (DEBUG_MODE) {
      window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data?.type) return;

        if (event.data.type === 'JP343_DOWNLOAD_LOGS') {
          const content = LOG_BUFFER.join('\n');
          const blob = new Blob([content], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `jp343-youtube-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.log`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          console.log('[JP343] Log-Datei heruntergeladen mit', LOG_BUFFER.length, 'Eintraegen');
        } else if (event.data.type === 'JP343_CLEAR_LOGS') {
          LOG_BUFFER.length = 0;
          console.log('[JP343] Log-Buffer geleert');
        } else if (event.data.type === 'JP343_LOG_STATUS') {
          console.log('[JP343] Log-Buffer:', LOG_BUFFER.length, 'Eintraege');
        }
      });
    }

    if (DEBUG_MODE) {
      console.log('[JP343] Debug-Logging aktiv. Befehle in Console:');
      console.log('  postMessage({type:"JP343_DOWNLOAD_LOGS"})');
      console.log('  postMessage({type:"JP343_CLEAR_LOGS"})');
      console.log('  postMessage({type:"JP343_LOG_STATUS"})');
    }

    // Sammelt alle relevanten UI-Elemente fuer Debug-Output (YouTube-spezifisch)
    function collectUIState(): Record<string, unknown> {
      const video = document.querySelector('video.html5-main-video') as HTMLVideoElement | null;
      const player = document.querySelector('#movie_player') as HTMLElement | null;

      // Ad-Selektoren einzeln pruefen
      const adSelectors: Record<string, string> = {
        'ytp-ad-player-overlay': '.ytp-ad-player-overlay',
        'ytp-ad-player-overlay-instream-info': '.ytp-ad-player-overlay-instream-info',
        'ytp-ad-text': '.ytp-ad-text',
        'ytp-ad-skip-button': '.ytp-ad-skip-button',
        'ytp-ad-skip-button-container': '.ytp-ad-skip-button-container',
        'ad-showing': '.ad-showing',
        'ytp-ad-preview-container': '.ytp-ad-preview-container',
        'ad-interrupting': '[class*="ad-interrupting"]'
      };

      const adSelectorResults: Record<string, boolean> = {};
      for (const [name, selector] of Object.entries(adSelectors)) {
        adSelectorResults[name] = !!document.querySelector(selector);
      }

      // Ad-Text-Inhalte erfassen
      const adTextElements = document.querySelectorAll('.ytp-ad-text, .ytp-ad-preview-text, .ytp-ad-skip-button-text');
      const adTexts: string[] = [];
      adTextElements.forEach(el => {
        if (el.textContent?.trim()) {
          adTexts.push(el.textContent.trim());
        }
      });

      // Alle Elemente mit "ad" oder "ytp-ad" in der Klasse (bis zu 20)
      const adClassElements = Array.from(document.querySelectorAll('[class*="ytp-ad"], [class*="ad-"]'))
        .slice(0, 20)
        .map(el => ({
          tag: el.tagName,
          classes: el.className,
          id: el.id || null,
          visible: (el as HTMLElement).offsetParent !== null,
          text: el.textContent?.trim()?.slice(0, 50) || null
        }));

      return {
        // Video-Element State
        videoExists: !!video,
        videoPaused: video?.paused ?? null,
        videoEnded: video?.ended ?? null,
        videoDuration: video?.duration ?? null,
        videoCurrentTime: video?.currentTime ?? null,

        // Player State
        playerExists: !!player,
        playerClasses: player?.className || null,
        playerHasAdShowing: player?.classList.contains('ad-showing') ?? false,

        // URL
        url: window.location.href,
        videoIdFromUrl: new URL(window.location.href).searchParams.get('v'),

        // Ad-Selektoren einzeln
        adSelectors: adSelectorResults,

        // Ad-Texte
        adTexts: adTexts,

        // Elemente mit Ad-Klassen
        adClassElements: adClassElements,

        // Interne States
        isCurrentlyAd: isCurrentlyAd,
        extensionContextValid: extensionContextValid
      };
    }

    // Debug DOM Mutation Observer
    if (DEBUG_MODE) {
      let lastPlayerAdShowing = false;  // Trackt ob ad-showing auf #movie_player aktiv war

      const debugMutationObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          // Node-Additionen
          mutation.addedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              const classes = node.className || '';
              const id = node.id || '';

              // Logge ad-bezogene Elemente
              const isAdRelated =
                /ytp-ad|ad-showing|ad-interrupting|ad-overlay/i.test(classes) ||
                /ytp-ad|ad-showing/i.test(id);

              if (isAdRelated) {
                debugLog('DOM_ADD', 'Neues Ad-Element hinzugefuegt', {
                  tag: node.tagName,
                  classes: classes,
                  id: id,
                  innerText: node.innerText?.slice(0, 100),
                  visible: node.offsetParent !== null
                });
              }
            }
          });

          // Node-Entfernungen
          mutation.removedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              const classes = node.className || '';
              const id = node.id || '';

              const isAdRelated =
                /ytp-ad|ad-showing|ad-interrupting|ad-overlay/i.test(classes) ||
                /ytp-ad|ad-showing/i.test(id);

              if (isAdRelated) {
                debugLog('DOM_REMOVE', 'Ad-Element entfernt', {
                  tag: node.tagName,
                  classes: classes,
                  id: id
                });
              }
            }
          });

          // Attribut-Mutationen: NUR loggen wenn sich ad-showing tatsaechlich aendert
          // YouTube aendert Klassen auf #movie_player staendig (autohide, playing-mode etc.)
          // Wir interessieren uns nur fuer den ad-showing Wechsel
          if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
            const target = mutation.target as HTMLElement;
            if (target.id === 'movie_player') {
              const hasAdShowing = target.classList.contains('ad-showing');
              if (hasAdShowing !== lastPlayerAdShowing) {
                lastPlayerAdShowing = hasAdShowing;
                debugLog('DOM_ATTR', hasAdShowing ? 'ad-showing AKTIVIERT' : 'ad-showing ENTFERNT', {
                  tag: target.tagName,
                  id: target.id,
                  hasAdShowing: hasAdShowing
                });
              }
            }
          }
        });
      });

      debugMutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class']
      });
      observers.push(debugMutationObserver);

      debugLog('INIT', 'Debug Mutation Observer gestartet');
    }

    // Pruefen ob Extension Context noch gueltig ist
    function isExtensionContextValid(): boolean {
      try {
        return extensionContextValid && !!browser.runtime?.id;
      } catch {
        return false;
      }
    }

    // Extension Context als ungueltig markieren und Intervals stoppen
    function invalidateExtensionContext(): void {
      if (extensionContextValid) {
        log('[JP343] Extension Context ungueltig - stoppe Tracking');
        debugLog('CONTEXT', 'Extension Context ungueltig - stoppe Tracking');
        extensionContextValid = false;
        if (adCheckInterval) {
          clearInterval(adCheckInterval);
          adCheckInterval = null;
        }
        if (stateUpdateInterval) {
          clearInterval(stateUpdateInterval);
          stateUpdateInterval = null;
        }
      }
    }

    // YouTube Video Element finden
    function findVideoElement(): HTMLVideoElement | null {
      const video = document.querySelector('video.html5-main-video') as HTMLVideoElement;
      return video || document.querySelector('video');
    }

    // Video-ID aus URL extrahieren
    function getVideoId(): string | null {
      const url = new URL(window.location.href);
      return url.searchParams.get('v');
    }

    // Video-Titel extrahieren
    function getVideoTitle(): string {
      // Methode 1: Titel-Element im Player-Bereich
      const titleSelectors = [
        'h1.ytd-video-primary-info-renderer yt-formatted-string',
        'h1.ytd-watch-metadata yt-formatted-string',
        '#title h1 yt-formatted-string',
        'ytd-watch-metadata h1 yt-formatted-string',
        '#above-the-fold #title yt-formatted-string',
        'h1.style-scope.ytd-watch-metadata'
      ];

      for (const selector of titleSelectors) {
        const element = document.querySelector(selector);
        if (element?.textContent?.trim()) {
          return element.textContent.trim();
        }
      }

      // Methode 2: Fallback auf document.title, aber Benachrichtigungen entfernen
      // YouTube zeigt "(3) Video Title - YouTube" wenn Benachrichtigungen da sind
      let title = document.title;
      // Entferne "(X) " am Anfang (Benachrichtigungs-Zaehler)
      title = title.replace(/^\(\d+\)\s*/, '');
      // Entferne " - YouTube" am Ende
      title = title.replace(/\s*-\s*YouTube$/, '');
      return title.trim() || 'YouTube Video';
    }

    // Thumbnail URL generieren (mqdefault ist schneller und kleiner als maxresdefault)
    function getThumbnailUrl(): string | null {
      const videoId = getVideoId();
      if (videoId) {
        return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
      }
      return null;
    }

    // Channel-Informationen extrahieren
    function getChannelInfo(): { id: string | null; name: string | null; url: string | null } {
      let channelId: string | null = null;
      let channelName: string | null = null;
      let channelUrl: string | null = null;

      // Methode 1: Channel-Name direkt aus yt-formatted-string (YouTube 2024/2025 Layout)
      const channelNameSelectors = [
        // Neue YouTube Layouts
        '#owner #channel-name yt-formatted-string#text a',
        '#owner #channel-name yt-formatted-string a',
        '#owner ytd-channel-name yt-formatted-string a',
        '#owner ytd-channel-name a',
        'ytd-video-owner-renderer #channel-name a',
        'ytd-video-owner-renderer ytd-channel-name a',
        // Fallback: Text direkt aus yt-formatted-string (ohne Link)
        '#owner #channel-name yt-formatted-string#text',
        '#owner ytd-channel-name yt-formatted-string',
        // Alte Selektoren als Fallback
        '#channel-name a',
        'ytd-channel-name a',
        '.ytd-video-owner-renderer a',
        '#owner a'
      ];

      // Erst Channel-Name finden
      for (const selector of channelNameSelectors) {
        const element = document.querySelector(selector);
        if (element?.textContent?.trim()) {
          channelName = element.textContent.trim();
          // Wenn es ein Link ist, auch URL extrahieren
          if (element instanceof HTMLAnchorElement && element.href) {
            channelUrl = element.href;
          }
          break;
        }
      }

      // Channel-URL separat suchen falls noch nicht gefunden
      if (!channelUrl) {
        const linkSelectors = [
          '#owner #channel-name a',
          '#owner ytd-channel-name a',
          'ytd-video-owner-renderer #channel-name a',
          '#owner a.yt-simple-endpoint'
        ];
        for (const selector of linkSelectors) {
          const link = document.querySelector(selector) as HTMLAnchorElement | null;
          if (link?.href && (link.href.includes('/channel/') || link.href.includes('/@'))) {
            channelUrl = link.href;
            // Falls Name noch nicht gefunden, aus Link nehmen
            if (!channelName && link.textContent?.trim()) {
              channelName = link.textContent.trim();
            }
            break;
          }
        }
      }

      // Channel-ID aus URL extrahieren
      if (channelUrl) {
        // Format: /channel/UC... oder /@username
        const channelMatch = channelUrl.match(/\/channel\/(UC[a-zA-Z0-9_-]+)/);
        if (channelMatch) {
          channelId = channelMatch[1];
        } else {
          // Handle /@username URLs - verwende die URL als ID
          const handleMatch = channelUrl.match(/\/@([a-zA-Z0-9_-]+)/);
          if (handleMatch) {
            channelId = `@${handleMatch[1]}`;
          }
        }
      }

      // Methode 2: Meta-Tag (Fallback)
      if (!channelId) {
        const metaChannel = document.querySelector('meta[itemprop="channelId"]') as HTMLMetaElement | null;
        if (metaChannel?.content) {
          channelId = metaChannel.content;
        }
      }

      // Methode 3: ytInitialPlayerResponse aus Script-Tags (Fallback)
      if (!channelId) {
        try {
          const scripts = document.querySelectorAll('script');
          for (const script of scripts) {
            if (script.textContent?.includes('ytInitialPlayerResponse')) {
              const match = script.textContent.match(/"channelId":"(UC[a-zA-Z0-9_-]+)"/);
              if (match) {
                channelId = match[1];
                break;
              }
            }
          }
        } catch {
          // Ignorieren falls Parse fehlschlaegt
        }
      }

      return { id: channelId, name: channelName, url: channelUrl };
    }

    // Werbung erkennen (optimiert: cached Player + minimale DOM-Queries)
    let cachedPlayer: HTMLElement | null = null;

    function isAdPlaying(): boolean {
      // Player-Element cachen (YouTube erstellt es nur einmal)
      if (!cachedPlayer || !cachedPlayer.isConnected) {
        cachedPlayer = document.querySelector('#movie_player');
      }
      // Hauptindikator: .ad-showing auf #movie_player (zuverlaessigster Check)
      if (cachedPlayer?.classList.contains('ad-showing')) return true;
      // Einziger Fallback: ein kombinierter querySelector (statt 8 einzelne)
      return !!document.querySelector('.ytp-ad-player-overlay, .ytp-ad-skip-button-container');
    }

    // Aktuellen Video-State zusammenstellen
    function getCurrentVideoState(): VideoState | null {
      const video = findVideoElement();
      if (!video) return null;

      const videoId = getVideoId();
      if (!videoId && !window.location.pathname.includes('/watch')) {
        return null;
      }

      // Channel-Info auslesen (kann bei SPA-Navigation kurzzeitig veraltet sein,
      // wird aber durch time-tracker.ts updateSessionChannelInfo korrigiert)
      const channelInfo = getChannelInfo();

      return {
        isPlaying: !video.paused && !video.ended,
        currentTime: video.currentTime,
        duration: video.duration || 0,
        title: getVideoTitle(),
        url: window.location.href,
        platform: 'youtube',
        isAd: isAdPlaying(),
        thumbnailUrl: getThumbnailUrl(),
        videoId: videoId,
        channelId: channelInfo.id,
        channelName: channelInfo.name,
        channelUrl: channelInfo.url
      };
    }

    // Message an Background senden
    async function sendMessage(type: string, data?: Record<string, unknown>): Promise<void> {
      // Frueh abbrechen wenn Context ungueltig
      if (!isExtensionContextValid()) {
        invalidateExtensionContext();
        return;
      }

      try {
        await browser.runtime.sendMessage({
          type,
          platform: 'youtube',
          ...data
        });
      } catch (error) {
        // "Extension context invalidated" abfangen
        if (error instanceof Error && error.message.includes('Extension context invalidated')) {
          invalidateExtensionContext();
          return;
        }
        log('[JP343] Message error:', error);
      }
    }

    // Video Events binden
    function attachVideoEvents(video: HTMLVideoElement): void {
      if (video.hasAttribute('data-jp343-tracked')) {
        return;
      }
      video.setAttribute('data-jp343-tracked', 'true');

      video.addEventListener('play', () => {
        if (!isExtensionContextValid()) return;
        if (DEBUG_MODE) debugLog('VIDEO_PLAY', '=== VIDEO PLAY EVENT ===', collectUIState());
        const state = getCurrentVideoState();
        if (state && !state.isAd) {
          sendMessage('VIDEO_PLAY', { state });
        }
      });

      video.addEventListener('pause', () => {
        if (!isExtensionContextValid()) return;
        if (DEBUG_MODE) debugLog('VIDEO_PAUSE', '=== VIDEO PAUSE EVENT ===', collectUIState());
        sendMessage('VIDEO_PAUSE');
      });

      video.addEventListener('ended', () => {
        if (!isExtensionContextValid()) return;
        if (DEBUG_MODE) debugLog('VIDEO_ENDED', '=== VIDEO ENDED EVENT ===', collectUIState());
        sendMessage('VIDEO_ENDED');
      });

      // State-Update Interval (nur wenn noch keins laeuft)
      if (!stateUpdateInterval) {
        stateUpdateInterval = setInterval(() => {
          if (!isExtensionContextValid()) {
            invalidateExtensionContext();
            return;
          }
          const state = getCurrentVideoState();
          if (state && state.isPlaying && !state.isAd) {
            sendMessage('VIDEO_STATE_UPDATE', { state });
          }
        }, 30000);
        intervalIds.push(stateUpdateInterval);
      }

      debugLog('INIT', 'Video Events gebunden', { src: video.src?.slice(0, 80) });
      log('[JP343] Video Events gebunden');

      // WICHTIG: Pruefen ob Video bereits spielt (z.B. bei direkter URL-Eingabe)
      // Das play-Event koennte schon gefeuert sein bevor wir den Listener hinzugefuegt haben
      setTimeout(() => {
        if (!isExtensionContextValid()) return;
        if (!video.paused && !video.ended) {
          const state = getCurrentVideoState();
          if (state && !state.isAd) {
            if (DEBUG_MODE) debugLog('VIDEO_PLAY', 'Video laeuft bereits - starte Tracking', collectUIState());
            log('[JP343] Video laeuft bereits - starte Tracking');
            sendMessage('VIDEO_PLAY', { state });
          }
        }
      }, 500);
    }

    // Ad-Status ueberwachen
    let lastAdState = false;  // Fuer State-Transition Logging
    function startAdMonitoring(): void {
      if (adCheckInterval) return;

      adCheckInterval = setInterval(() => {
        if (!isExtensionContextValid()) {
          invalidateExtensionContext();
          return;
        }

        const isAd = isAdPlaying();

        // Logging nur bei State-Transitions (nicht bei jedem 500ms-Check)
        if (DEBUG_MODE && isAd !== lastAdState) {
          lastAdState = isAd;
          if (isAd) {
            debugLog('AD_STATE', '=== WERBUNG BEGINNT ===', collectUIState());
          } else {
            debugLog('AD_STATE', '=== WERBUNG BEENDET ===', collectUIState());
          }
        }

        if (isAd && !isCurrentlyAd) {
          isCurrentlyAd = true;
          sendMessage('AD_START');
        } else if (!isAd && isCurrentlyAd) {
          isCurrentlyAd = false;
          sendMessage('AD_END');
        }
      }, 2000);
      intervalIds.push(adCheckInterval);
    }

    // Ad-Monitoring stoppen (bei URL-Wechsel, verhindert Interval-Pile-up)
    function stopAdMonitoring(): void {
      if (adCheckInterval) {
        clearInterval(adCheckInterval);
        adCheckInterval = null;
      }
      // WICHTIG: Background ueber Ad-Ende informieren bevor State zurueckgesetzt wird
      // Ohne das bleibt der Background im "Ad"-State haengen (Fix Iteration 6b)
      if (isCurrentlyAd) {
        sendMessage('AD_END');
      }
      isCurrentlyAd = false;
    }

    // State-Update-Interval stoppen (bei URL-Wechsel)
    function stopStateUpdates(): void {
      if (stateUpdateInterval) {
        clearInterval(stateUpdateInterval);
        stateUpdateInterval = null;
      }
    }

    // URL-Wechsel erkennen (YouTube ist eine SPA)
    let urlChangeInProgress = false;

    function handleUrlChange(): void {
      if (!isExtensionContextValid()) return;

      const currentUrl = window.location.href;

      if (currentUrl !== lastVideoUrl) {
        // Deduplizierung: MutationObserver, yt-navigate-finish und popstate
        // koennen gleichzeitig feuern
        if (urlChangeInProgress) return;
        urlChangeInProgress = true;

        debugLog('URL_CHANGE', '=== URL WECHSEL ===', {
          oldUrl: lastVideoUrl,
          newUrl: currentUrl
        });

        // WICHTIG: Alte Session beenden bevor neue URL gesetzt wird
        // Das stellt sicher dass Video-zu-Video nahtlos funktioniert
        if (lastVideoUrl && lastVideoUrl.includes('/watch')) {
          log('[JP343] URL-Wechsel - beende vorherige Session');
          sendMessage('VIDEO_ENDED');
        }

        lastVideoUrl = currentUrl;

        // Player-Cache resetten (YouTube kann Player bei Navigation neu erstellen)
        cachedPlayer = null;

        // ALLE Intervals sofort stoppen!
        // Verhindert Interval-Pile-up waehrend YouTubes DOM-Sturm.
        // (2000ms adCheck + 30s stateUpdate stauen sich in der Event Queue
        // und feuern als Burst wenn der Main Thread kurz frei wird → Feedback-Loop → Freeze)
        stopAdMonitoring();
        stopStateUpdates();

        // Video-Element Reset: erzwingt Neuerkennung
        // data-jp343-tracked zuruecksetzen damit attachVideoEvents neu binden kann
        // (YouTube kann <video> Element wiederverwenden)
        if (currentVideoElement) {
          currentVideoElement.removeAttribute('data-jp343-tracked');
        }
        currentVideoElement = null;

        // Observer disconnecten (falls noch connected)
        disconnectObserver();

        setTimeout(() => {
          urlChangeInProgress = false; // Naechsten URL-Wechsel erlauben
          if (!isExtensionContextValid()) return;
          const video = findVideoElement();
          if (video) {
            currentVideoElement = video;
            attachVideoEvents(video);
            startAdMonitoring();
          }
          // KEIN Observer-Reconnect! yt-navigate-finish + popstate decken URL-Wechsel ab.
          // Video-Polling-Timer findet Video-Elemente falls hier noch nicht bereit.
        }, 1000);
      }
    }

    // DEBUG: Periodisch alle 5 Sekunden vollstaendigen State loggen (nur wenn Video laeuft)
    if (DEBUG_MODE) {
      const debugPeriodicId = setInterval(() => {
        const video = findVideoElement();
        if (video && !video.paused) {
          debugLog('PERIODIC', 'Periodischer State-Check', collectUIState());
        }
      }, 5000);
      intervalIds.push(debugPeriodicId);
    }

    // MutationObserver fuer initiales Video-Laden
    // Nur aktiv bis das erste Video gefunden wird, dann permanent disconnected.
    // URL-Wechsel werden ausschliesslich ueber yt-navigate-finish + popstate erkannt.
    // Video-Erkennung nach Navigation uebernimmt der Video-Polling-Timer.
    let observerConnected = false;

    const observer = new MutationObserver(() => {
      if (!isExtensionContextValid()) {
        observer.disconnect();
        observerConnected = false;
        return;
      }

      // MO ist nur aktiv bis initiales Video gefunden wird.
      if (!currentVideoElement) {
        const video = findVideoElement();
        if (video) {
          currentVideoElement = video;
          attachVideoEvents(video);
          startAdMonitoring();
          disconnectObserver();
        }
      }
    });

    function connectObserver(): void {
      if (observerConnected) return;
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
      observerConnected = true;
    }

    function disconnectObserver(): void {
      if (!observerConnected) return;
      observer.disconnect();
      observerConnected = false;
    }

    connectObserver();
    observers.push(observer);

    // Initiale Suche - mehrfach versuchen falls Video noch nicht geladen
    function tryInitialVideoAttach(attempts = 0): void {
      if (!isExtensionContextValid()) return;

      const video = findVideoElement();
      if (video) {
        currentVideoElement = video;
        attachVideoEvents(video);
        startAdMonitoring();
        // Observer nicht mehr noetig - yt-navigate-finish + polling uebernehmen
        disconnectObserver();
        debugLog('INIT', 'Video gefunden', { attempts });
        log('[JP343] Video gefunden nach', attempts, 'Versuchen');
      } else if (attempts < 10) {
        // Nochmal versuchen (max 10x = 5 Sekunden)
        setTimeout(() => tryInitialVideoAttach(attempts + 1), 500);
      }
    }

    // Nur auf Watch-Seiten initial suchen
    if (window.location.pathname.includes('/watch')) {
      tryInitialVideoAttach();
    }

    // Leichtgewichtiger Video-Polling-Timer
    // Ersetzt den MutationObserver fuer Video-Element-Erkennung nach Navigation.
    // Kostet ~0.01ms pro Check vs. MutationObserver der 10.000x/s feuert.
    const videoPollingId = setInterval(() => {
      if (!isExtensionContextValid()) return;
      if (currentVideoElement) return; // Schon gefunden, nichts tun
      if (!window.location.pathname.includes('/watch')) return; // Nicht auf Watch-Seite

      const video = findVideoElement();
      if (video) {
        currentVideoElement = video;
        attachVideoEvents(video);
        startAdMonitoring();
      }
    }, 2000);
    intervalIds.push(videoPollingId);

    // URL-Aenderungen via Browser-Events
    window.addEventListener('popstate', () => {
      setTimeout(handleUrlChange, 100);
    });

    // YouTube-eigenes Navigation-Event als primaere URL-Erkennung
    document.addEventListener('yt-navigate-finish', () => {
      setTimeout(handleUrlChange, 100);
    });

    lastVideoUrl = window.location.href;

    // PAUSE_VIDEO: Video pausieren wenn "Stop & Save" geklickt wird
    browser.runtime.onMessage.addListener((message) => {
      if (message?.type === 'PAUSE_VIDEO' && currentVideoElement) {
        currentVideoElement.pause();
      }
      if (message?.type === 'RESUME_VIDEO' && currentVideoElement) {
        currentVideoElement.play();
      }
    });

    debugLog('INIT', 'YouTube Content Script vollstaendig initialisiert', {
      url: window.location.href,
      isWatchPage: window.location.pathname.includes('/watch')
    });
  }
});
