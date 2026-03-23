// =============================================================================
// JP343 Extension - Comprehensible Japanese (cijapanese.com) Content Script
// Vidstack Player: <media-player> -> <media-provider> -> <video>
// Keine Werbung, kein iframe, standard HTML5 Video Events
// =============================================================================

import type { VideoState } from '../../types';

export default defineContentScript({
  matches: ['*://*.cijapanese.com/*'],
  runAt: 'document_idle',

  main() {
    let currentVideoElement: HTMLVideoElement | null = null;
    let lastTitle: string = '';
    let lastVideoId: string | null = null;

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
        sendMessage('VIDEO_ENDED');
      }
      cleanup();
    });
    window.addEventListener('beforeunload', () => {
      if (lastVideoId) {
        sendMessage('VIDEO_ENDED');
      }
    });

    const DEBUG_MODE = import.meta.env.DEV;
    const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};
    log('[JP343] CI Japanese Content Script geladen');
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

    // Debug-Funktionen in Page Context
    if (DEBUG_MODE) {
      const script = document.createElement('script');
      script.textContent = `
        window.JP343_downloadLogs = function() {
          window.dispatchEvent(new CustomEvent('JP343_REQUEST_LOGS'));
        };
        window.JP343_clearLogs = function() {
          window.dispatchEvent(new CustomEvent('JP343_CLEAR_LOGS'));
        };
        console.log('[JP343] Debug aktiv. Befehle: JP343_downloadLogs(), JP343_clearLogs()');
      `;
      (document.head || document.documentElement).appendChild(script);
      script.remove();

      window.addEventListener('JP343_REQUEST_LOGS', () => {
        const content = LOG_BUFFER.join('\n');
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `jp343-cijapanese-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.log`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      });

      window.addEventListener('JP343_CLEAR_LOGS', () => {
        LOG_BUFFER.length = 0;
        console.log('[JP343] Log-Buffer geleert');
      });
    }

    // UI-State fuer Debug
    function collectUIState(): Record<string, unknown> {
      const video = findVideoElement();
      const mediaPlayer = document.querySelector('media-player');
      return {
        videoExists: !!video,
        videoPaused: video?.paused ?? null,
        videoEnded: video?.ended ?? null,
        videoDuration: video?.duration ?? null,
        videoCurrentTime: video?.currentTime ?? null,
        url: window.location.href,
        documentTitle: document.title,
        lastVideoId,
        lastTitle,
        // Vidstack Player Attribute
        mediaPlayerPlaying: mediaPlayer?.hasAttribute('data-playing') ?? null,
        mediaPlayerStarted: mediaPlayer?.hasAttribute('data-started') ?? null,
        mediaPlayerPaused: mediaPlayer?.hasAttribute('data-paused') ?? null,
        mediaPlayerEnded: mediaPlayer?.hasAttribute('data-ended') ?? null,
      };
    }

    // Debug DOM Observer
    if (DEBUG_MODE) {
      const debugObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              const tag = node.tagName.toLowerCase();
              if (tag === 'video' || tag === 'media-player' || tag === 'media-provider') {
                debugLog('DOM_ADD', 'Media Element', { tag, classes: node.className });
              }
            }
          });
        });
      });
      debugObserver.observe(document.body, { childList: true, subtree: true });
      observers.push(debugObserver);
      debugLog('INIT', 'Debug Observer gestartet');

      // Periodischer State-Check
      intervalIds.push(setInterval(() => {
        const video = findVideoElement();
        if (video && !video.paused) {
          debugLog('PERIODIC', 'State-Check', collectUIState());
        }
      }, 5000));
    }

    // =======================================================================
    // VIDEO + TITEL ERKENNUNG
    // =======================================================================

    function findVideoElement(): HTMLVideoElement | null {
      // NUR Vidstack Player Videos (echte Inhalte), NICHT Deko-Videos (.video-clips, autoplay loop)
      return (document.querySelector('media-provider video') as HTMLVideoElement)
        || (document.querySelector('[data-media-player] video') as HTMLVideoElement)
        || null;  // Kein Fallback auf beliebiges <video> - sonst wird Landing-Deko getrackt
    }

    // Seiten die NICHT getrackt werden sollen
    const IGNORE_PATHS = ['/landing', '/pricing', '/about', '/login', '/signup', '/register'];

    function isWatchPage(): boolean {
      const path = window.location.pathname.replace(/\/$/, '');
      if (IGNORE_PATHS.includes(path) || path === '' || path === '/') return false;
      // Nur tracken wenn ein Vidstack Player vorhanden ist
      return !!document.querySelector('media-player');
    }

    function getVideoId(): string | null {
      // URL als ID nutzen (kein Standard-ID-Format bei CI Japanese)
      // /watch/123 oder /videos/xyz oder aehnlich
      const path = window.location.pathname;
      // Pfad ohne trailing slash als ID
      return path.replace(/\/$/, '') || null;
    }

    function getTitle(): string {
      // 1. Vidstack Player Title
      const mediaPlayer = document.querySelector('media-player');
      const playerTitle = mediaPlayer?.getAttribute('title');
      if (playerTitle && playerTitle.length > 1) {
        return playerTitle;
      }

      // 2. Seiten-Heading
      const headings = ['h1', 'h2.video-title', '.video-title', '[class*="title"]'];
      for (const selector of headings) {
        const el = document.querySelector(selector);
        const text = el?.textContent?.trim();
        if (text && text.length > 2 && text.length < 200) {
          return text;
        }
      }

      // 3. Document Title
      const docTitle = document.title
        .replace(/\s*[\|–-]\s*Comprehensible Japanese.*$/i, '')
        .replace(/\s*[\|–-]\s*CI Japanese.*$/i, '')
        .trim();
      if (docTitle && docTitle.length > 1) {
        return docTitle;
      }

      return 'CI Japanese Content';
    }

    function getThumbnail(): string | null {
      // Vidstack Poster
      const poster = document.querySelector('media-poster img') as HTMLImageElement;
      if (poster?.src) return poster.src;

      // media-player poster Attribut
      const mediaPlayer = document.querySelector('media-player');
      const posterAttr = mediaPlayer?.getAttribute('poster');
      if (posterAttr) return posterAttr;

      // OG Image
      const ogImage = document.querySelector('meta[property="og:image"]') as HTMLMetaElement;
      if (ogImage?.content) return ogImage.content;

      return null;
    }

    // =======================================================================
    // VIDEO STATE + MESSAGING
    // =======================================================================

    function getCurrentVideoState(): VideoState | null {
      const video = findVideoElement();
      if (!video) return null;

      const videoId = getVideoId();
      if (!videoId) return null;

      return {
        isPlaying: !video.paused && !video.ended,
        currentTime: video.currentTime,
        duration: video.duration || 0,
        title: getTitle(),
        url: window.location.href,
        platform: 'generic',
        isAd: false,  // Keine Werbung auf CI Japanese
        thumbnailUrl: getThumbnail(),
        videoId: videoId,
        channelId: null,
        channelName: null,
        channelUrl: null
      };
    }

    async function sendMessage(type: string, data?: Record<string, unknown>): Promise<void> {
      try {
        await browser.runtime.sendMessage({
          type,
          platform: 'generic',
          ...data
        });
      } catch (error) {
        log('[JP343] CI Japanese: Message error:', error);
      }
    }

    // =======================================================================
    // VIDEO EVENT BINDING
    // =======================================================================

    function attachVideoEvents(video: HTMLVideoElement): void {
      if (video.hasAttribute('data-jp343-tracked')) return;
      video.setAttribute('data-jp343-tracked', 'true');

      video.addEventListener('play', () => {
        if (!isWatchPage()) {
          log('[JP343] CI Japanese: Play auf Nicht-Watch-Seite ignoriert');
          return;
        }
        debugLog('VIDEO_PLAY', '=== PLAY ===', collectUIState());

        const videoId = getVideoId();
        if (videoId && lastVideoId && videoId !== lastVideoId) {
          // Video-Wechsel
          sendMessage('VIDEO_ENDED');
        }

        const state = getCurrentVideoState();
        if (state) {
          lastVideoId = videoId;
          lastTitle = state.title;
          log('[JP343] CI Japanese Play:', state.title);
          sendMessage('VIDEO_PLAY', { state });
        }
      });

      video.addEventListener('pause', () => {
        debugLog('VIDEO_PAUSE', '=== PAUSE ===', collectUIState());
        sendMessage('VIDEO_PAUSE');
      });

      video.addEventListener('ended', () => {
        debugLog('VIDEO_ENDED', '=== ENDED ===', collectUIState());
        sendMessage('VIDEO_ENDED');
        lastVideoId = null;
      });

      // Periodische Updates (alle 30 Sekunden)
      const updateInterval = setInterval(() => {
        const state = getCurrentVideoState();
        if (state && state.isPlaying) {
          const currentVideoId = getVideoId();
          if (currentVideoId && lastVideoId && currentVideoId !== lastVideoId) {
            log('[JP343] CI Japanese: Video-Wechsel:', lastVideoId, '->', currentVideoId);
            sendMessage('VIDEO_ENDED');
            lastVideoId = currentVideoId;
            lastTitle = state.title;
            setTimeout(() => {
              const newState = getCurrentVideoState();
              if (newState && newState.isPlaying) {
                sendMessage('VIDEO_PLAY', { state: newState });
              }
            }, 500);
          } else {
            if (state.title !== lastTitle) {
              lastTitle = state.title;
            }
            sendMessage('VIDEO_STATE_UPDATE', { state });
          }
        }
      }, 30000);
      intervalIds.push(updateInterval);

      // Schnelle Titel-Updates
      let quickCount = 0;
      const quickUpdate = setInterval(() => {
        quickCount++;
        if (video.paused) return;
        const state = getCurrentVideoState();
        if (state && state.isPlaying && state.title !== lastTitle) {
          lastTitle = state.title;
          sendMessage('VIDEO_STATE_UPDATE', { state });
        }
        if (quickCount >= 6) clearInterval(quickUpdate);
      }, 5000);
      intervalIds.push(quickUpdate);

      log('[JP343] CI Japanese: Events gebunden');
    }

    // =======================================================================
    // OBSERVER + INIT
    // =======================================================================

    const observer = new MutationObserver(() => {
      if (!isWatchPage()) return;
      const video = findVideoElement();
      if (video && video !== currentVideoElement) {
        currentVideoElement = video;
        attachVideoEvents(video);
        const videoId = getVideoId();

        if (!video.paused && !video.ended && videoId) {
          log('[JP343] CI Japanese: Video laeuft bereits');
          lastVideoId = videoId;
          lastTitle = getTitle();
          const state = getCurrentVideoState();
          if (state) {
            sendMessage('VIDEO_PLAY', { state });
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    observers.push(observer);

    // Initiales Video suchen (nur auf Watch-Seiten)
    const initialVideo = isWatchPage() ? findVideoElement() : null;
    if (initialVideo) {
      currentVideoElement = initialVideo;
      attachVideoEvents(initialVideo);
      const videoId = getVideoId();

      if (!initialVideo.paused && !initialVideo.ended && videoId) {
        log('[JP343] CI Japanese: Initiales Video laeuft');
        lastVideoId = videoId;
        lastTitle = getTitle();
        const state = getCurrentVideoState();
        if (state) {
          sendMessage('VIDEO_PLAY', { state });
        }
      }
    }

    // SPA Navigation (URL Polling)
    let lastUrl = window.location.href;
    intervalIds.push(setInterval(() => {
      if (window.location.href !== lastUrl) {
        const oldUrl = lastUrl;
        lastUrl = window.location.href;
        debugLog('URL_CHANGE', 'URL Wechsel', { oldUrl, newUrl: lastUrl });
        log('[JP343] CI Japanese: URL-Wechsel:', oldUrl, '->', lastUrl);

        // Alte Session beenden bei Navigation
        if (lastVideoId) {
          sendMessage('VIDEO_ENDED');
          lastVideoId = null;
          lastTitle = '';
        }

        // Nach neuem Video suchen - kurz warten bis SPA-Navigation fertig ist
        setTimeout(() => {
          if (!isWatchPage()) return;
          const video = findVideoElement();
          if (video) {
            if (video !== currentVideoElement) {
              currentVideoElement = video;
              attachVideoEvents(video);
            }
            // Video laeuft bereits (Play-Event kam vor URL-Change)
            const videoId = getVideoId();
            if (!video.paused && !video.ended && videoId && !lastVideoId) {
              log('[JP343] CI Japanese: Video laeuft nach URL-Wechsel');
              lastVideoId = videoId;
              lastTitle = getTitle();
              const state = getCurrentVideoState();
              if (state) {
                sendMessage('VIDEO_PLAY', { state });
              }
            }
          }
        }, 500);
      }
    }, 1000));

    // Fallback: Nach 3s pruefen
    setTimeout(() => {
      if (!isWatchPage()) return;
      const video = findVideoElement();
      const videoId = getVideoId();
      if (video && !video.paused && !video.ended && videoId && !lastVideoId) {
        log('[JP343] CI Japanese: Verzoegertes Tracking');
        lastVideoId = videoId;
        lastTitle = getTitle();
        const state = getCurrentVideoState();
        if (state) {
          sendMessage('VIDEO_PLAY', { state });
        }
      }
    }, 3000);

    // PAUSE/RESUME vom Popup
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
