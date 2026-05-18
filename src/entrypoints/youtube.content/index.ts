// JP343 Extension - YouTube Content Script

import type { VideoState, WhitelistedChannel, BlockedChannel } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { createDebugLogger, setupDebugCommands, DEBUG_MODE } from '../../lib/debug-logger';
import { extractVideoIdFromUrl, WATCH_TITLE_SELECTORS } from '../../lib/youtube-utils';
import { isJapaneseContent } from '../../lib/language-detection';
import { showTrackingToast, hideTrackingToast, isToastActive } from '../../lib/tracking-toast';

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
    let lastVideoPlayTime = 0;
    let lastVideoPauseTime = 0;
    let pendingRetryTimeouts: ReturnType<typeof setTimeout>[] = [];
    let originalTitle: string | null = null;
    let originalTitleVideoId: string | null = null;
    let originalTitleRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let useOriginalTitles = false;
    let trackJapaneseOnly = false;
    let hideNonJapanese = false;
    let whitelistedChannels: WhitelistedChannel[] = [];
    let blockedChannels: BlockedChannel[] = [];
    const DEDUP_WINDOW_MS = 200;

    document.querySelectorAll('video[data-jp343-tracked]').forEach(v => {
      v.removeAttribute('data-jp343-tracked');
    });

    const observers: MutationObserver[] = [];
    const intervalIds: ReturnType<typeof setInterval>[] = [];
    function cleanup(): void {
      observers.forEach(o => o.disconnect());
      intervalIds.forEach(clearInterval);
      observers.length = 0;
      intervalIds.length = 0;
      if (originalTitleRetryTimer) clearTimeout(originalTitleRetryTimer);
      window.removeEventListener('jp343-original-title', handleOriginalTitleResponse);
    }
    window.addEventListener('pagehide', () => {
      if (lastVideoUrl && lastVideoUrl.includes('/watch')) {
        const state = getCurrentVideoState();
        sendMessage('VIDEO_ENDED', state ? { state } : undefined);
      }
      cleanup();
    });
    window.addEventListener('pageshow', (e) => {
      if (e.persisted && isExtensionContextValid()) {
        const video = findVideoElement();
        if (video) {
          video.removeAttribute('data-jp343-tracked');
          currentVideoElement = video;
          attachVideoEvents(video);
          startAdMonitoring();
        }
      }
    });
    window.addEventListener('beforeunload', () => {
      if (lastVideoUrl && lastVideoUrl.includes('/watch')) {
        const state = getCurrentVideoState();
        sendMessage('VIDEO_ENDED', state ? { state } : undefined);
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (!extensionContextValid) return;
      if (!document.hidden) {
        const video = currentVideoElement;
        if (!video) return;
        if (video.ended) {
          const state = getCurrentVideoState();
          sendMessage('VIDEO_ENDED', state ? { state } : undefined);
        } else if (!video.paused && !video.ended) {
          const state = getCurrentVideoState();
          if (state && !state.isAd) {
            sendVideoPlay(state);
          }
        } else if (video.paused) {
          sendVideoPause();
        }
      }
    });

    const logger = createDebugLogger('youtube');
    const { log, debugLog } = logger;
    log('[JP343] YouTube Content Script loaded');

    const isIncognito = browser.extension?.inIncognitoContext ?? false;

    function sendDiagnostic(code: string): void {
      if (isIncognito) return;
      try {
        browser.runtime.sendMessage({ type: 'DIAGNOSTIC_EVENT', code, platform: 'youtube' }).catch(() => {});
      } catch { /* best-effort */ }
    }

    function sendVideoPlay(state: VideoState): void {
      if (window.location.pathname.startsWith('/shorts/')) return;
      const now = Date.now();
      if (now - lastVideoPlayTime < DEDUP_WINDOW_MS) return;
      lastVideoPlayTime = now;
      sendMessage('VIDEO_PLAY', { state });
      sendDiagnostic('video_play_sent');
      sendDiagnostic(state.title && state.title !== 'YouTube Video' ? 'metadata_found' : 'metadata_missing');
    }

    function sendVideoPause(): void {
      const now = Date.now();
      if (now - lastVideoPauseTime < DEDUP_WINDOW_MS) return;
      lastVideoPauseTime = now;
      sendMessage('VIDEO_PAUSE');
    }

    sendDiagnostic('content_script_loaded');

    function onOriginalTitleSettingChanged(): void {
      if (!originalTitle) return;
      const state = getCurrentVideoState();
      if (state && state.isPlaying && !state.isAd) {
        sendMessage('VIDEO_STATE_UPDATE', { state });
      }
    }

    browser.runtime.sendMessage({ type: 'GET_SETTINGS' }).then((response) => {
      if (response?.success && response.data?.settings) {
        const prev = useOriginalTitles;
        useOriginalTitles = response.data.settings.useOriginalTitles ?? false;
        trackJapaneseOnly = response.data.settings.trackJapaneseOnly ?? false;
        hideNonJapanese = response.data.settings.hideNonJapanese ?? false;
        whitelistedChannels = response.data.settings.whitelistedChannels ?? [];
        blockedChannels = response.data.settings.blockedChannels ?? [];
        if (useOriginalTitles !== prev) onOriginalTitleSettingChanged();
      }
    }).catch(() => {});

    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[STORAGE_KEYS.SETTINGS]?.newValue) {
        const prev = useOriginalTitles;
        useOriginalTitles = changes[STORAGE_KEYS.SETTINGS].newValue.useOriginalTitles ?? false;
        trackJapaneseOnly = changes[STORAGE_KEYS.SETTINGS].newValue.trackJapaneseOnly ?? false;
        hideNonJapanese = changes[STORAGE_KEYS.SETTINGS].newValue.hideNonJapanese ?? false;
        whitelistedChannels = changes[STORAGE_KEYS.SETTINGS].newValue.whitelistedChannels ?? [];
        blockedChannels = changes[STORAGE_KEYS.SETTINGS].newValue.blockedChannels ?? [];
        if (useOriginalTitles !== prev) onOriginalTitleSettingChanged();
        checkTrackingToast();
      }
    });

    if (DEBUG_MODE) { setupDebugCommands(logger, 'youtube'); }

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
      return extractVideoIdFromUrl();
    }

    function readTitleFromDOM(): string | null {
      for (const selector of WATCH_TITLE_SELECTORS) {
        const element = document.querySelector(selector);
        if (element?.textContent?.trim()) {
          return element.textContent.trim();
        }
      }
      return null;
    }

    let cachedTitle: string | null = null;
    let titleVideoId: string | null = null;

    function getVideoTitle(): string {
      const currentVideoId = getVideoId();
      if (cachedTitle && titleVideoId === currentVideoId) {
        const freshTitle = readTitleFromDOM();
        if (freshTitle && freshTitle !== cachedTitle) {
          cachedTitle = freshTitle;
        }
        return cachedTitle;
      }

      const title = readTitleFromDOM();
      if (title) {
        cachedTitle = title;
        titleVideoId = currentVideoId;
        return title;
      }

      let fallback = document.title;
      fallback = fallback.replace(/^\(\d+\)\s*/, '');
      fallback = fallback.replace(/\s*-\s*YouTube$/, '');
      return fallback.trim() || 'YouTube Video';
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
        '#owner a',
        'h3.slim-owner-channel-name span',
        '.slim-owner-channel-name span'
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

      if (!channelName) {
        const channelNameEl = document.querySelector('ytd-channel-name #container, ytd-channel-name');
        const raw = channelNameEl?.textContent?.trim();
        if (raw) {
          channelName = raw.split('\n').map(s => s.trim()).find(s => s.length > 0) || null;
        }
      }

      if (!channelUrl) {
        const linkSelectors = [
          '#owner #channel-name a',
          '#owner ytd-channel-name a',
          'ytd-video-owner-renderer #channel-name a',
          '#owner a.yt-simple-endpoint',
          'a.slim-owner-icon-and-title[href*="/@"]'
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

      // UC-ID from meta tag is most reliable
      const metaChannel = document.querySelector('meta[itemprop="channelId"]') as HTMLMetaElement | null;
      if (metaChannel?.content?.startsWith('UC')) {
        channelId = metaChannel.content;
      }

      if (!channelId && channelUrl) {
        const channelMatch = channelUrl.match(/\/channel\/(UC[a-zA-Z0-9_-]+)/);
        if (channelMatch) {
          channelId = channelMatch[1];
        }
      }

      if (!channelId && channelUrl) {
        const handleMatch = channelUrl.match(/\/@([^/?#]+)/);
        if (handleMatch) {
          try { channelId = `@${decodeURIComponent(handleMatch[1])}`; }
          catch { channelId = `@${handleMatch[1]}`; }
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

    function handleOriginalTitleResponse(e: Event): void {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;
      if (detail.videoId !== originalTitleVideoId) return;
      if (detail.title && typeof detail.title === 'string') {
        originalTitle = detail.title;
        log('[JP343] Original title:', originalTitle);
        sendDiagnostic('original_title_success');
        const state = getCurrentVideoState();
        if (state && state.isPlaying && !state.isAd) {
          sendMessage('VIDEO_STATE_UPDATE', { state });
        }
        checkTrackingToast();
      }
    }

    window.addEventListener('jp343-original-title', handleOriginalTitleResponse);

    function requestOriginalTitle(videoId: string | null): void {
      if (!videoId) { originalTitle = null; return; }
      originalTitle = null;
      originalTitleVideoId = videoId;
      if (originalTitleRetryTimer) {
        clearTimeout(originalTitleRetryTimer);
        originalTitleRetryTimer = null;
      }
      attemptOriginalTitle(videoId, 0);
    }

    function attemptOriginalTitle(videoId: string | null, attempt: number): void {
      if (attempt >= 3) {
        sendDiagnostic('original_title_fallback');
        checkTrackingToast();
        return;
      }
      try {
        const script = document.createElement('script');
        script.src = browser.runtime.getURL('/inject-yt-original-title.js');
        document.documentElement.appendChild(script);
      } catch {
        log('[JP343] Failed to inject original title script');
      }
      if (!originalTitle) {
        originalTitleRetryTimer = setTimeout(() => attemptOriginalTitle(videoId, attempt + 1), 1000);
      }
    }

    function checkTrackingToast(): void {
      if (!hideNonJapanese || !trackJapaneseOnly) { hideTrackingToast(); return; }
      if (useOriginalTitles && !originalTitle && originalTitleVideoId === getVideoId()) return;
      const state = getCurrentVideoState();

      if (state?.channelId) {
        if (whitelistedChannels.some(c => c.channelId === state.channelId)) { hideTrackingToast(); return; }
        if (blockedChannels.some(c => c.channelId === state.channelId)) { hideTrackingToast(); return; }
      }

      if (isToastActive()) return;

      if (!state || state.isAd) return;
      if (!state.channelId || !state.channelName) return;
      if (isJapaneseContent(state.title)) return;
      if (!isJapaneseContent(state.channelName)) return;

      const player = document.querySelector('#movie_player') || document.querySelector('.player-container');
      const channelMsg = {
        channelId: state.channelId!,
        channelName: state.channelName!,
        channelUrl: state.channelUrl || null,
      };

      showTrackingToast(state.channelId, {
        channelName: state.channelName,
        container: player,
        onAllow: () => {
          browser.runtime.sendMessage({
            type: 'WHITELIST_CHANNEL',
            channel: { ...channelMsg, whitelistedAt: new Date().toISOString() }
          }).then(() => {
            const freshState = getCurrentVideoState();
            if (freshState && freshState.isPlaying && !freshState.isAd) {
              sendVideoPlay(freshState);
            }
          }).catch(() => {});
        },
        onBlock: () => {
          browser.runtime.sendMessage({
            type: 'BLOCK_CHANNEL',
            channel: { ...channelMsg, blockedAt: new Date().toISOString() }
          }).catch(() => {});
        }
      });
    }

    function getCurrentVideoState(): VideoState | null {
      const video = findVideoElement();
      if (!video) return null;

      const videoId = getVideoId();
      if (!videoId && !window.location.pathname.includes('/watch')) {
        return null;
      }

      const channelInfo = getChannelInfo();

      return {
        isPlaying: !video.paused && !video.ended,
        currentTime: video.currentTime,
        duration: video.duration || 0,
        title: (useOriginalTitles && originalTitle) || getVideoTitle(),
        url: window.location.href,
        platform: 'youtube',
        isAd: isAdPlaying(),
        thumbnailUrl: getThumbnailUrl(),
        videoId: videoId,
        channelId: channelInfo.id,
        channelName: channelInfo.name,
        channelUrl: channelInfo.url,
        originalTitle: originalTitle || null
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
      if (window.location.pathname.startsWith('/shorts/')) return;
      if (video.hasAttribute('data-jp343-tracked')) {
        return;
      }
      video.setAttribute('data-jp343-tracked', 'true');

      video.addEventListener('play', () => {
        if (!isExtensionContextValid()) return;
        if (video !== currentVideoElement) return;
        if (DEBUG_MODE) debugLog('VIDEO_PLAY', '=== VIDEO PLAY EVENT ===', collectUIState());
        requestOriginalTitle(getVideoId());
        const state = getCurrentVideoState();
        if (state && !state.isAd) {
          const initialTitle = state.title;
          sendVideoPlay(state);

          pendingRetryTimeouts.push(setTimeout(() => {
            if (!isExtensionContextValid()) return;
            const freshState = getCurrentVideoState();
            if (freshState && freshState.title !== initialTitle) {
              log('[JP343] Title updated:', initialTitle, '->', freshState.title);
              sendMessage('VIDEO_STATE_UPDATE', { state: freshState });
            }
          }, 1500));

          pendingRetryTimeouts.push(setTimeout(checkTrackingToast, 2500));

          if (!state.channelId) {
            const retryDelays = [2000, 4000, 8000];
            let retryIndex = 0;
            const recheckChannel = (): void => {
              if (retryIndex >= retryDelays.length || !isExtensionContextValid()) return;
              pendingRetryTimeouts.push(setTimeout(() => {
                const freshState = getCurrentVideoState();
                if (freshState?.channelId) {
                  sendMessage('VIDEO_STATE_UPDATE', { state: freshState });
                } else {
                  retryIndex++;
                  recheckChannel();
                }
              }, retryDelays[retryIndex]));
            };
            recheckChannel();
          }
        }
      });

      video.addEventListener('pause', () => {
        if (!isExtensionContextValid()) return;
        if (video !== currentVideoElement) return;
        if (DEBUG_MODE) debugLog('VIDEO_PAUSE', '=== VIDEO PAUSE EVENT ===', collectUIState());
        sendVideoPause();
      });

      video.addEventListener('ended', () => {
        if (!isExtensionContextValid()) return;
        if (video !== currentVideoElement) return;
        if (DEBUG_MODE) debugLog('VIDEO_ENDED', '=== VIDEO ENDED EVENT ===', collectUIState());
        const endState = getCurrentVideoState();
        sendMessage('VIDEO_ENDED', endState ? { state: endState } : undefined);
        hideTrackingToast();
      });

      video.addEventListener('waiting', () => {
        if (!isExtensionContextValid()) return;
        if (video !== currentVideoElement) return;
        if (!isCurrentlyAd) {
          sendVideoPause();
        }
      });

      video.addEventListener('emptied', () => {
        if (!isExtensionContextValid()) return;
        if (video !== currentVideoElement) return;
        if (document.hidden && video.paused && video.readyState === 0) {
          sendVideoPause();
        }
      });

      video.addEventListener('playing', () => {
        if (!isExtensionContextValid()) return;
        if (video !== currentVideoElement) return;
        const state = getCurrentVideoState();
        if (state && !state.isAd) {
          sendVideoPlay(state);
        }
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
            sendVideoPlay(state);
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

        try {
        debugLog('URL_CHANGE', '=== URL CHANGED ===', {
          oldUrl: lastVideoUrl,
          newUrl: currentUrl
        });

        if (lastVideoUrl && lastVideoUrl.includes('/watch')) {
          log('[JP343] URL change - ending previous session');
          const urlChangeState = getCurrentVideoState();
          sendMessage('VIDEO_ENDED', urlChangeState ? { state: urlChangeState } : undefined);
        }

        hideTrackingToast();
        lastVideoUrl = currentUrl;

        cachedPlayer = null;

        stopAdMonitoring();
        stopStateUpdates();
        pendingRetryTimeouts.forEach(clearTimeout);
        pendingRetryTimeouts = [];
        if (originalTitleRetryTimer) {
          clearTimeout(originalTitleRetryTimer);
          originalTitleRetryTimer = null;
        }
        originalTitle = null;

        if (currentVideoElement) {
          currentVideoElement.removeAttribute('data-jp343-tracked');
        }
        currentVideoElement = null;

        disconnectObserver();
        } catch (err) { log('[JP343] URL change cleanup error:', err); }

        setTimeout(() => {
          urlChangeInProgress = false;
          if (!isExtensionContextValid()) return;
          requestOriginalTitle(getVideoId());
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
        requestOriginalTitle(getVideoId());
        currentVideoElement = video;
        attachVideoEvents(video);
        startAdMonitoring();
        disconnectObserver();
        debugLog('INIT', 'Video found', { attempts });
        log('[JP343] Video found after', attempts, 'attempts');
        sendDiagnostic('player_found');
      } else if (attempts < 10) {
        setTimeout(() => tryInitialVideoAttach(attempts + 1), 500);
      } else {
        sendDiagnostic('player_missing');
      }
    }

    if (window.location.pathname.includes('/watch')) {
      tryInitialVideoAttach();
    }

    const videoPollingId = setInterval(() => {
      if (!isExtensionContextValid()) return;
      if (window.location.href !== lastVideoUrl) {
        handleUrlChange();
        return;
      }
      if (currentVideoElement && currentVideoElement.isConnected) return;
      if (!window.location.pathname.includes('/watch')) return;

      const video = findVideoElement();
      if (video) {
        currentVideoElement = video;
        attachVideoEvents(video);
        startAdMonitoring();
        sendDiagnostic('player_found');
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
      if (message?.type === 'TAB_ACTIVATED') {
        if (!extensionContextValid) return;
        const video = currentVideoElement;
        if (!video) return;
        if (video.ended) {
          const state = getCurrentVideoState();
          sendMessage('VIDEO_ENDED', state ? { state } : undefined);
        } else if (!video.paused && !video.ended) {
          const state = getCurrentVideoState();
          if (state && !state.isAd) {
            sendVideoPlay(state);
          }
        } else if (video.paused) {
          sendVideoPause();
        }
      }
    });

    debugLog('INIT', 'YouTube Content Script fully initialized', {
      url: window.location.href,
      isWatchPage: window.location.pathname.includes('/watch')
    });
  }
});
