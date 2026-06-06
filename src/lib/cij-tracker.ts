import type { VideoState, Platform } from '../types';
import { createDebugLogger, setupDebugCommands, DEBUG_MODE } from './debug-logger';
import { showUpdateNotification } from './update-notification';

export interface CijSiteConfig {
  platform: Platform;
  channelId: string;
  channelName: string;
  channelUrl: string;
  loggerKey: string;
  fallbackTitle: string;
  titleStripPatterns: RegExp[];
}

export function createCijTracker(config: CijSiteConfig): void {
  let currentVideoElement: HTMLVideoElement | null = null;
  let lastTitle: string = '';
  let lastVideoId: string | null = null;
  let lastVideoTime = 0;
  let accumulatedDeltaMs = 0;
  let currentSessionId: string | null = null;
  let pauseDebounceTimer: ReturnType<typeof setTimeout> | null = null;

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
      flushDelta();
      sendMessage('VIDEO_ENDED');
    }
    cleanup();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      flushDelta();
    }
    if (!document.hidden) {
      if (!isWatchPage()) return;
      const video = findVideoElement();
      if (video && video.ended) {
        sendMessage('VIDEO_ENDED');
      } else if (video && !video.paused && !video.ended) {
        const state = getCurrentVideoState();
        if (state) {
          sendVideoPlay(state);
        }
      } else if (video && video.paused) {
        sendMessage('VIDEO_PAUSE');
      }
    }
  });

  const logger = createDebugLogger(config.loggerKey);
  const { log, debugLog } = logger;
  const logName = config.channelName;
  log(`[JP343] ${logName} content script loaded`);
  if (DEBUG_MODE) { setupDebugCommands(logger, config.loggerKey, { logStatus: false }); }

  const IGNORE_PATHS = ['/landing', '/pricing', '/about', '/login', '/signup', '/register'];

  const isIncognito = browser.extension?.inIncognitoContext ?? false;
  function sendDiagnostic(code: string): void {
    if (isIncognito) return;
    try {
      browser.runtime.sendMessage({ type: 'DIAGNOSTIC_EVENT', code, platform: config.platform }).catch(() => {});
    } catch { /* best-effort */ }
  }
  function sendVideoPlay(state: VideoState): void {
    flushDelta();
    accumulatedDeltaMs = 0;
    sendMessage('VIDEO_PLAY', { state }).then(response => {
      if (response && typeof response === 'object' && 'sessionId' in response) {
        currentSessionId = (response as { sessionId: string }).sessionId;
      }
    });
    sendDiagnostic('video_play_sent');
    sendDiagnostic(state.title && state.title !== config.fallbackTitle ? 'metadata_found' : 'metadata_missing');
  }

  function flushDelta(): void {
    if (accumulatedDeltaMs <= 0 || !currentSessionId) return;
    const ms = accumulatedDeltaMs;
    accumulatedDeltaMs = 0;
    sendMessage('TIME_DELTA', { deltaMs: Math.round(ms), sessionId: currentSessionId });
  }

  sendDiagnostic('content_script_loaded');
  if (isWatchPage()) {
    setTimeout(() => { if (!currentVideoElement) sendDiagnostic('player_missing'); }, 15000);
  }

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

  function isWatchPage(): boolean {
    const path = window.location.pathname.replace(/\/$/, '');
    if (IGNORE_PATHS.includes(path) || path === '' || path === '/') return false;
    return !!document.querySelector('media-player');
  }

  function getVideoId(): string | null {
    const match = window.location.pathname.match(/\/videos?\/(\d+)/);
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

    let docTitle = document.title;
    for (const pattern of config.titleStripPatterns) {
      docTitle = docTitle.replace(pattern, '');
    }
    docTitle = docTitle.trim();
    if (docTitle && docTitle.length > 1) {
      return docTitle;
    }

    return config.fallbackTitle;
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
      platform: config.platform,
      isAd: false,
      thumbnailUrl: getThumbnail(),
      videoId: videoId,
      channelId: config.channelId,
      channelName: config.channelName,
      channelUrl: config.channelUrl
    };
  }

  async function sendMessage(type: string, data?: Record<string, unknown>): Promise<unknown> {
    try {
      return await browser.runtime.sendMessage({
        type,
        platform: config.platform,
        ...data
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('Extension context invalidated')) {
        showUpdateNotification();
        return;
      }
      log(`[JP343] ${logName}: Message error:`, error);
      return undefined;
    }
  }

  function attachVideoEvents(video: HTMLVideoElement): void {
    if (video.hasAttribute('data-jp343-tracked')) return;
    video.setAttribute('data-jp343-tracked', 'true');

    video.addEventListener('play', () => {
      if (pauseDebounceTimer) { clearTimeout(pauseDebounceTimer); pauseDebounceTimer = null; sendDiagnostic('pause_debounced'); }
      lastVideoTime = video.currentTime;
      flushDelta();
      accumulatedDeltaMs = 0;
      if (!isWatchPage()) {
        log(`[JP343] ${logName}: Play on non-watch page ignored`);
        return;
      }
      debugLog('VIDEO_PLAY', '=== PLAY ===', collectUIState());

      const videoId = getVideoId();
      if (videoId && lastVideoId && videoId !== lastVideoId) {
        flushDelta();
        sendMessage('VIDEO_ENDED');
      }

      const state = getCurrentVideoState();
      if (state) {
        lastVideoId = videoId;
        lastTitle = state.title;
        log(`[JP343] ${logName} Play:`, state.title);
        sendVideoPlay(state);
      }
    });

    video.addEventListener('pause', () => {
      debugLog('VIDEO_PAUSE', '=== PAUSE ===', collectUIState());
      flushDelta();
      if (pauseDebounceTimer) clearTimeout(pauseDebounceTimer);
      pauseDebounceTimer = setTimeout(() => {
        pauseDebounceTimer = null;
        if (video.paused && !video.ended) {
          sendMessage('VIDEO_PAUSE');
        }
      }, 300);
    });

    video.addEventListener('ended', () => {
      debugLog('VIDEO_ENDED', '=== ENDED ===', collectUIState());
      flushDelta();
      sendMessage('VIDEO_ENDED');
      lastVideoId = null;
    });

    video.addEventListener('waiting', () => {
      flushDelta();
    });

    video.addEventListener('emptied', () => {
      if (document.hidden && video.paused && video.readyState === 0) {
        flushDelta();
        sendMessage('VIDEO_PAUSE');
      }
    });

    video.addEventListener('playing', () => {
      if (pauseDebounceTimer) { clearTimeout(pauseDebounceTimer); pauseDebounceTimer = null; sendDiagnostic('pause_debounced'); }
      lastVideoTime = video.currentTime;
      flushDelta();
      accumulatedDeltaMs = 0;
      const state = getCurrentVideoState();
      if (state) {
        sendVideoPlay(state);
      }
    });

    video.addEventListener('timeupdate', () => {
      if (video.paused || video.ended) return;
      const ct = video.currentTime;
      const d = ct - lastVideoTime;
      lastVideoTime = ct;
      if (d > 0 && d <= 10) {
        const realDelta = d / (video.playbackRate || 1);
        accumulatedDeltaMs += realDelta * 1000;
        if (accumulatedDeltaMs >= 10_000) {
          flushDelta();
        }
      }
    });

    const updateInterval = setInterval(() => {
      const state = getCurrentVideoState();
      if (state && state.isPlaying) {
        const currentVideoId = getVideoId();
        if (currentVideoId && lastVideoId && currentVideoId !== lastVideoId) {
          log(`[JP343] ${logName}: Video switch:`, lastVideoId, '->', currentVideoId);
          sendMessage('VIDEO_ENDED');
          lastVideoId = currentVideoId;
          lastTitle = state.title;
          setTimeout(() => {
            const newState = getCurrentVideoState();
            if (newState && newState.isPlaying) {
              sendVideoPlay(newState);
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

    log(`[JP343] ${logName}: Events bound`);
    sendDiagnostic('player_found');
  }

  const observer = new MutationObserver(() => {
    if (!isWatchPage()) return;
    const video = findVideoElement();
    if (video && video !== currentVideoElement) {
      currentVideoElement = video;
      attachVideoEvents(video);
      const videoId = getVideoId();

      if (!video.paused && !video.ended && videoId) {
        log(`[JP343] ${logName}: Video already playing`);
        lastVideoId = videoId;
        lastTitle = getTitle();
        const state = getCurrentVideoState();
        if (state) {
          sendVideoPlay(state);
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
      log(`[JP343] ${logName}: Initial video playing`);
      lastVideoId = videoId;
      lastTitle = getTitle();
      const state = getCurrentVideoState();
      if (state) {
        sendVideoPlay(state);
      }
    }
  }

  let lastUrl = window.location.href;
  intervalIds.push(setInterval(() => {
    if (window.location.href !== lastUrl) {
      const oldUrl = lastUrl;
      lastUrl = window.location.href;
      debugLog('URL_CHANGE', 'URL changed', { oldUrl, newUrl: lastUrl });
      log(`[JP343] ${logName}: URL change:`, oldUrl, '->', lastUrl);

      if (lastVideoId) {
        flushDelta();
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
            log(`[JP343] ${logName}: Video playing after URL change`);
            lastVideoId = videoId;
            lastTitle = getTitle();
            const state = getCurrentVideoState();
            if (state) {
              sendVideoPlay(state);
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
      log(`[JP343] ${logName}: Delayed tracking pickup`);
      lastVideoId = videoId;
      lastTitle = getTitle();
      const state = getCurrentVideoState();
      if (state) {
        sendVideoPlay(state);
      }
    }
  }, 3000);

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === 'GET_CONTENT_TIME') {
      if (!currentSessionId) return undefined;
      return Promise.resolve({ unflushedMs: Math.round(accumulatedDeltaMs), sessionId: currentSessionId });
    }
    if (message?.type === 'PAUSE_VIDEO' && currentVideoElement) {
      currentVideoElement.pause();
    }
    if (message?.type === 'RESUME_VIDEO' && currentVideoElement) {
      currentVideoElement.play();
    }
    if (message?.type === 'TAB_ACTIVATED') {
      if (!isWatchPage()) return;
      const video = findVideoElement();
      if (video && video.ended) {
        sendMessage('VIDEO_ENDED');
      } else if (video && !video.paused && !video.ended) {
        const state = getCurrentVideoState();
        if (state) {
          sendVideoPlay(state);
        }
      } else if (video && video.paused) {
        sendMessage('VIDEO_PAUSE');
      }
    }
    return undefined;
  });
}
