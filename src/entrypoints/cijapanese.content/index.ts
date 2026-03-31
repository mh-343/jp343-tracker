import type { VideoState } from '../../types';
import { createDebugLogger, setupDebugCommands, DEBUG_MODE } from '../../lib/debug-logger';

export default defineContentScript({
  matches: ['*://*.cijapanese.com/*'],
  runAt: 'document_idle',

  main() {
    let currentVideoElement: HTMLVideoElement | null = null;
    let lastTitle: string = '';
    let lastVideoId: string | null = null;

    const observers: MutationObserver[] = [];
    const intervalIds: ReturnType<typeof setInterval>[] = [];
    function cleanup(): void {
      observers.forEach(o => o.disconnect());
      intervalIds.forEach(clearInterval);
      observers.length = 0;
      intervalIds.length = 0;
    }

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

    const logger = createDebugLogger('cijapanese');
    const { log, debugLog } = logger;
    log('[JP343] CI Japanese content script loaded');
    setupDebugCommands(logger, 'cijapanese', { logStatus: false });

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
        mediaPlayerPlaying: mediaPlayer?.hasAttribute('data-playing') ?? null,
        mediaPlayerStarted: mediaPlayer?.hasAttribute('data-started') ?? null,
        mediaPlayerPaused: mediaPlayer?.hasAttribute('data-paused') ?? null,
        mediaPlayerEnded: mediaPlayer?.hasAttribute('data-ended') ?? null,
      };
    }

    if (DEBUG_MODE) {
      const domObserver = new MutationObserver((mutations) => {
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
      domObserver.observe(document.body, { childList: true, subtree: true });
      observers.push(domObserver);
      debugLog('INIT', 'Debug observer started');

      intervalIds.push(setInterval(() => {
        const video = findVideoElement();
        if (video && !video.paused) {
          debugLog('PERIODIC', 'State check', collectUIState());
        }
      }, 5000));
    }

    function findVideoElement(): HTMLVideoElement | null {
      return (document.querySelector('media-provider video') as HTMLVideoElement)
        || (document.querySelector('[data-media-player] video') as HTMLVideoElement)
        || null;
    }

    const IGNORE_PATHS = ['/landing', '/pricing', '/about', '/login', '/signup', '/register'];

    function isWatchPage(): boolean {
      const path = window.location.pathname.replace(/\/$/, '');
      if (IGNORE_PATHS.includes(path) || path === '' || path === '/') return false;
      return !!document.querySelector('media-player');
    }

    function getVideoId(): string | null {
      const match = window.location.pathname.match(/\/video\/(\d+)/);
      return match ? match[1] : null;
    }

    function getTitle(): string {
      const mediaPlayer = document.querySelector('media-player');
      const playerTitle = mediaPlayer?.getAttribute('title');
      if (playerTitle && playerTitle.length > 1) {
        return playerTitle;
      }

      const headings = ['h1', 'h2.video-title', '.video-title', '[class*="title"]'];
      for (const selector of headings) {
        const el = document.querySelector(selector);
        const text = el?.textContent?.trim();
        if (text && text.length > 2 && text.length < 200) {
          return text;
        }
      }

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
      const poster = document.querySelector('media-poster img') as HTMLImageElement;
      if (poster?.src) return poster.src;

      const mediaPlayer = document.querySelector('media-player');
      const posterAttr = mediaPlayer?.getAttribute('poster');
      if (posterAttr) return posterAttr;

      const ogImage = document.querySelector('meta[property="og:image"]') as HTMLMetaElement;
      if (ogImage?.content) return ogImage.content;

      return null;
    }

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
        platform: 'cijapanese',
        isAd: false,
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
          platform: 'cijapanese',
          ...data
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes('Extension context invalidated')) return;
        log('[JP343] CI Japanese: Message error:', error);
      }
    }

    function attachVideoEvents(video: HTMLVideoElement): void {
      if (video.hasAttribute('data-jp343-tracked')) return;
      video.setAttribute('data-jp343-tracked', 'true');

      video.addEventListener('play', () => {
        if (!isWatchPage()) {
          log('[JP343] CI Japanese: Play on non-watch page ignored');
          return;
        }
        debugLog('VIDEO_PLAY', '=== PLAY ===', collectUIState());

        const videoId = getVideoId();
        if (videoId && lastVideoId && videoId !== lastVideoId) {
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

      const updateInterval = setInterval(() => {
        const state = getCurrentVideoState();
        if (state && state.isPlaying) {
          const currentVideoId = getVideoId();
          if (currentVideoId && lastVideoId && currentVideoId !== lastVideoId) {
            log('[JP343] CI Japanese: Video switch:', lastVideoId, '->', currentVideoId);
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

      log('[JP343] CI Japanese: Events bound');
    }

    const observer = new MutationObserver(() => {
      if (!isWatchPage()) return;
      const video = findVideoElement();
      if (video && video !== currentVideoElement) {
        currentVideoElement = video;
        attachVideoEvents(video);
        const videoId = getVideoId();

        if (!video.paused && !video.ended && videoId) {
          log('[JP343] CI Japanese: Video already playing');
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

    const initialVideo = isWatchPage() ? findVideoElement() : null;
    if (initialVideo) {
      currentVideoElement = initialVideo;
      attachVideoEvents(initialVideo);
      const videoId = getVideoId();

      if (!initialVideo.paused && !initialVideo.ended && videoId) {
        log('[JP343] CI Japanese: Initial video playing');
        lastVideoId = videoId;
        lastTitle = getTitle();
        const state = getCurrentVideoState();
        if (state) {
          sendMessage('VIDEO_PLAY', { state });
        }
      }
    }

    let lastUrl = window.location.href;
    intervalIds.push(setInterval(() => {
      if (window.location.href !== lastUrl) {
        const oldUrl = lastUrl;
        lastUrl = window.location.href;
        debugLog('URL_CHANGE', 'URL changed', { oldUrl, newUrl: lastUrl });
        log('[JP343] CI Japanese: URL change:', oldUrl, '->', lastUrl);

        if (lastVideoId) {
          sendMessage('VIDEO_ENDED');
          lastVideoId = null;
          lastTitle = '';
        }

        setTimeout(() => {
          if (!isWatchPage()) return;
          const video = findVideoElement();
          if (video) {
            if (video !== currentVideoElement) {
              currentVideoElement = video;
              attachVideoEvents(video);
            }
            const videoId = getVideoId();
            if (!video.paused && !video.ended && videoId && !lastVideoId) {
              log('[JP343] CI Japanese: Video playing after URL change');
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

    setTimeout(() => {
      if (!isWatchPage()) return;
      const video = findVideoElement();
      const videoId = getVideoId();
      if (video && !video.paused && !video.ended && videoId && !lastVideoId) {
        log('[JP343] CI Japanese: Delayed tracking pickup');
        lastVideoId = videoId;
        lastTitle = getTitle();
        const state = getCurrentVideoState();
        if (state) {
          sendMessage('VIDEO_PLAY', { state });
        }
      }
    }, 3000);

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
