// JP343 Extension - YouTube Content Script

import type { VideoState } from '../../types';
import { createDebugLogger, DEBUG_MODE, downloadBuffer } from '../../lib/debug-logger';

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

    const observers: MutationObserver[] = [];
    const intervalIds: ReturnType<typeof setInterval>[] = [];
    function cleanup(): void {
      observers.forEach(o => o.disconnect());
      intervalIds.forEach(clearInterval);
      observers.length = 0;
      intervalIds.length = 0;
    }
    window.addEventListener('pagehide', cleanup);

    const { log, debugLog, getBuffer, clearBuffer } = createDebugLogger('youtube');
    log('[JP343] YouTube Content Script loaded');

    if (DEBUG_MODE) {
      window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data?.type) return;
        if (event.data.type === 'JP343_DOWNLOAD_LOGS') downloadBuffer(getBuffer(), 'youtube');
        else if (event.data.type === 'JP343_CLEAR_LOGS') { clearBuffer(); console.log('[JP343] Log buffer cleared'); }
        else if (event.data.type === 'JP343_LOG_STATUS') console.log('[JP343] Log buffer:', getBuffer().length, 'entries');
      });
      console.log('[JP343] Debug logging active. Console commands:');
      console.log('  postMessage({type:"JP343_DOWNLOAD_LOGS"})');
      console.log('  postMessage({type:"JP343_CLEAR_LOGS"})');
      console.log('  postMessage({type:"JP343_LOG_STATUS"})');
    }

    function collectUIState(): Record<string, unknown> {
      const video = document.querySelector('video.html5-main-video') as HTMLVideoElement | null;
      const player = document.querySelector('#movie_player') as HTMLElement | null;

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

      const adTextElements = document.querySelectorAll('.ytp-ad-text, .ytp-ad-preview-text, .ytp-ad-skip-button-text');
      const adTexts: string[] = [];
      adTextElements.forEach(el => {
        if (el.textContent?.trim()) {
          adTexts.push(el.textContent.trim());
        }
      });

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
        videoExists: !!video,
        videoPaused: video?.paused ?? null,
        videoEnded: video?.ended ?? null,
        videoDuration: video?.duration ?? null,
        videoCurrentTime: video?.currentTime ?? null,
        playerExists: !!player,
        playerClasses: player?.className || null,
        playerHasAdShowing: player?.classList.contains('ad-showing') ?? false,
        url: window.location.href,
        videoIdFromUrl: new URL(window.location.href).searchParams.get('v'),
        adSelectors: adSelectorResults,
        adTexts: adTexts,
        adClassElements: adClassElements,
        isCurrentlyAd: isCurrentlyAd,
        extensionContextValid: extensionContextValid
      };
    }

    if (DEBUG_MODE) {
      let lastPlayerAdShowing = false;

      const domObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              const classes = node.className || '';
              const id = node.id || '';

              const isAdRelated =
                /ytp-ad|ad-showing|ad-interrupting|ad-overlay/i.test(classes) ||
                /ytp-ad|ad-showing/i.test(id);

              if (isAdRelated) {
                debugLog('DOM_ADD', 'New ad element added', {
                  tag: node.tagName,
                  classes: classes,
                  id: id,
                  innerText: node.innerText?.slice(0, 100),
                  visible: node.offsetParent !== null
                });
              }
            }
          });

          mutation.removedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              const classes = node.className || '';
              const id = node.id || '';

              const isAdRelated =
                /ytp-ad|ad-showing|ad-interrupting|ad-overlay/i.test(classes) ||
                /ytp-ad|ad-showing/i.test(id);

              if (isAdRelated) {
                debugLog('DOM_REMOVE', 'Ad element removed', {
                  tag: node.tagName,
                  classes: classes,
                  id: id
                });
              }
            }
          });

          if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
            const target = mutation.target as HTMLElement;
            if (target.id === 'movie_player') {
              const hasAdShowing = target.classList.contains('ad-showing');
              if (hasAdShowing !== lastPlayerAdShowing) {
                lastPlayerAdShowing = hasAdShowing;
                debugLog('DOM_ATTR', hasAdShowing ? 'ad-showing ACTIVATED' : 'ad-showing REMOVED', {
                  tag: target.tagName,
                  id: target.id,
                  hasAdShowing: hasAdShowing
                });
              }
            }
          }
        });
      });

      domObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class']
      });
      observers.push(domObserver);

      debugLog('INIT', 'Debug Mutation Observer started');
    }

    function isExtensionContextValid(): boolean {
      try {
        return extensionContextValid && !!browser.runtime?.id;
      } catch {
        return false;
      }
    }

    function invalidateExtensionContext(): void {
      if (extensionContextValid) {
        log('[JP343] Extension context invalid - stopping tracking');
        debugLog('CONTEXT', 'Extension context invalid - stopping tracking');
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

    function findVideoElement(): HTMLVideoElement | null {
      const video = document.querySelector('video.html5-main-video') as HTMLVideoElement;
      return video || document.querySelector('video');
    }

    function getVideoId(): string | null {
      const url = new URL(window.location.href);
      return url.searchParams.get('v');
    }

    function getVideoTitle(): string {
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

      let title = document.title;
      title = title.replace(/^\(\d+\)\s*/, '');
      title = title.replace(/\s*-\s*YouTube$/, '');
      return title.trim() || 'YouTube Video';
    }

    function getThumbnailUrl(): string | null {
      const videoId = getVideoId();
      if (videoId) {
        return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
      }
      return null;
    }

    function getChannelInfo(): { id: string | null; name: string | null; url: string | null } {
      let channelId: string | null = null;
      let channelName: string | null = null;
      let channelUrl: string | null = null;

      const channelNameSelectors = [
        '#owner #channel-name yt-formatted-string#text a',
        '#owner #channel-name yt-formatted-string a',
        '#owner ytd-channel-name yt-formatted-string a',
        '#owner ytd-channel-name a',
        'ytd-video-owner-renderer #channel-name a',
        'ytd-video-owner-renderer ytd-channel-name a',
        '#owner #channel-name yt-formatted-string#text',
        '#owner ytd-channel-name yt-formatted-string',
        '#channel-name a',
        'ytd-channel-name a',
        '.ytd-video-owner-renderer a',
        '#owner a'
      ];

      for (const selector of channelNameSelectors) {
        const element = document.querySelector(selector);
        if (element?.textContent?.trim()) {
          channelName = element.textContent.trim();
          if (element instanceof HTMLAnchorElement && element.href) {
            channelUrl = element.href;
          }
          break;
        }
      }

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
            if (!channelName && link.textContent?.trim()) {
              channelName = link.textContent.trim();
            }
            break;
          }
        }
      }

      if (channelUrl) {
        const channelMatch = channelUrl.match(/\/channel\/(UC[a-zA-Z0-9_-]+)/);
        if (channelMatch) {
          channelId = channelMatch[1];
        } else {
          const handleMatch = channelUrl.match(/\/@([a-zA-Z0-9_-]+)/);
          if (handleMatch) {
            channelId = `@${handleMatch[1]}`;
          }
        }
      }

      if (!channelId) {
        const metaChannel = document.querySelector('meta[itemprop="channelId"]') as HTMLMetaElement | null;
        if (metaChannel?.content) {
          channelId = metaChannel.content;
        }
      }

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
          // Ignore parse failures
        }
      }

      return { id: channelId, name: channelName, url: channelUrl };
    }

    let cachedPlayer: HTMLElement | null = null;

    function isAdPlaying(): boolean {
      if (!cachedPlayer || !cachedPlayer.isConnected) {
        cachedPlayer = document.querySelector('#movie_player');
      }
      if (cachedPlayer?.classList.contains('ad-showing')) return true;
      return !!document.querySelector('.ytp-ad-player-overlay-layout, .ytp-ad-player-overlay, .ytp-skip-ad, .ytp-ad-skip-button-container, .ytp-ad-persistent-progress-bar-container');
    }

    function getCurrentVideoState(): VideoState | null {
      const video = findVideoElement();
      if (!video) return null;

      const videoId = getVideoId();
      if (!videoId && !window.location.pathname.includes('/watch')) {
        return null;
      }

      // time-tracker.ts updateSessionChannelInfo corrects this
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

    async function sendMessage(type: string, data?: Record<string, unknown>): Promise<void> {
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
        if (error instanceof Error && error.message.includes('Extension context invalidated')) {
          invalidateExtensionContext();
          return;
        }
        log('[JP343] Message error:', error);
      }
    }

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

      debugLog('INIT', 'Video events bound', { src: video.src?.slice(0, 80) });
      log('[JP343] Video events bound');

      setTimeout(() => {
        if (!isExtensionContextValid()) return;
        if (!video.paused && !video.ended) {
          const state = getCurrentVideoState();
          if (state && !state.isAd) {
            if (DEBUG_MODE) debugLog('VIDEO_PLAY', 'Video already playing - starting tracking', collectUIState());
            log('[JP343] Video already playing - starting tracking');
            sendMessage('VIDEO_PLAY', { state });
          }
        }
      }, 500);
    }

    let lastAdState = false;
    function startAdMonitoring(): void {
      if (adCheckInterval) return;

      adCheckInterval = setInterval(() => {
        if (!isExtensionContextValid()) {
          invalidateExtensionContext();
          return;
        }

        const isAd = isAdPlaying();

        if (DEBUG_MODE && isAd !== lastAdState) {
          lastAdState = isAd;
          if (isAd) {
            debugLog('AD_STATE', '=== AD STARTED ===', collectUIState());
          } else {
            debugLog('AD_STATE', '=== AD ENDED ===', collectUIState());
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

    function stopAdMonitoring(): void {
      if (adCheckInterval) {
        clearInterval(adCheckInterval);
        adCheckInterval = null;
      }
      if (isCurrentlyAd) {
        sendMessage('AD_END');
      }
      isCurrentlyAd = false;
    }

    function stopStateUpdates(): void {
      if (stateUpdateInterval) {
        clearInterval(stateUpdateInterval);
        stateUpdateInterval = null;
      }
    }

    let urlChangeInProgress = false;

    function handleUrlChange(): void {
      if (!isExtensionContextValid()) return;

      const currentUrl = window.location.href;

      if (currentUrl !== lastVideoUrl) {
        if (urlChangeInProgress) return;
        urlChangeInProgress = true;

        debugLog('URL_CHANGE', '=== URL CHANGED ===', {
          oldUrl: lastVideoUrl,
          newUrl: currentUrl
        });

        if (lastVideoUrl && lastVideoUrl.includes('/watch')) {
          log('[JP343] URL change - ending previous session');
          sendMessage('VIDEO_ENDED');
        }

        lastVideoUrl = currentUrl;

        cachedPlayer = null;

        stopAdMonitoring();
        stopStateUpdates();

        // (YouTube can reuse the <video> element)
        if (currentVideoElement) {
          currentVideoElement.removeAttribute('data-jp343-tracked');
        }
        currentVideoElement = null;

        disconnectObserver();

        setTimeout(() => {
          urlChangeInProgress = false;
          if (!isExtensionContextValid()) return;
          const video = findVideoElement();
          if (video) {
            currentVideoElement = video;
            attachVideoEvents(video);
            startAdMonitoring();
          }
        }, 1000);
      }
    }

    if (DEBUG_MODE) {
      const periodicCheckId = setInterval(() => {
        const video = findVideoElement();
        if (video && !video.paused) {
          debugLog('PERIODIC', 'Periodic state check', collectUIState());
        }
      }, 5000);
      intervalIds.push(periodicCheckId);
    }

    let observerConnected = false;

    const observer = new MutationObserver(() => {
      if (!isExtensionContextValid()) {
        observer.disconnect();
        observerConnected = false;
        return;
      }

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

    function tryInitialVideoAttach(attempts = 0): void {
      if (!isExtensionContextValid()) return;

      const video = findVideoElement();
      if (video) {
        currentVideoElement = video;
        attachVideoEvents(video);
        startAdMonitoring();
        disconnectObserver();
        debugLog('INIT', 'Video found', { attempts });
        log('[JP343] Video found after', attempts, 'attempts');
      } else if (attempts < 10) {
        setTimeout(() => tryInitialVideoAttach(attempts + 1), 500);
      }
    }

    if (window.location.pathname.includes('/watch')) {
      tryInitialVideoAttach();
    }

    const videoPollingId = setInterval(() => {
      if (!isExtensionContextValid()) return;
      if (currentVideoElement) return;
      if (!window.location.pathname.includes('/watch')) return;

      const video = findVideoElement();
      if (video) {
        currentVideoElement = video;
        attachVideoEvents(video);
        startAdMonitoring();
      }
    }, 2000);
    intervalIds.push(videoPollingId);

    window.addEventListener('popstate', () => {
      setTimeout(handleUrlChange, 100);
    });

    document.addEventListener('yt-navigate-finish', () => {
      setTimeout(handleUrlChange, 100);
    });

    lastVideoUrl = window.location.href;

    browser.runtime.onMessage.addListener((message) => {
      if (message?.type === 'PAUSE_VIDEO' && currentVideoElement) {
        currentVideoElement.pause();
      }
      if (message?.type === 'RESUME_VIDEO' && currentVideoElement) {
        currentVideoElement.play();
      }
    });

    debugLog('INIT', 'YouTube Content Script fully initialized', {
      url: window.location.href,
      isWatchPage: window.location.pathname.includes('/watch')
    });
  }
});
