// JP343 Extension - YouTube Content Script

import type { VideoState, WhitelistedChannel, BlockedChannel, ExtensionSettings } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { createDebugLogger, setupDebugCommands, DEBUG_MODE } from '../../lib/debug-logger';
import { extractVideoIdFromUrl, WATCH_TITLE_SELECTORS, isChannelInList, isWatchPath, isWatchUrl, canonicalWatchUrl } from '../../lib/youtube-utils';
import { isJapaneseContent, isJapaneseLanguageCode, isLikelyJapaneseVideo } from '../../lib/language-detection';
import { showTrackingToast, hideTrackingToast, isToastActive } from '../../lib/tracking-toast';
import { hideDifficultyChip, isDifficultyChipMounted } from '../../lib/difficulty-chip';
import { stopFeedBadges, scheduleFeedBadgeSweep } from './feed-badges';
import { initDifficulty, applyDifficultySettings, handleDifficultyStorageChange, updateDifficultyChip, pollLocalVoteGate, getLocalSensorEstimate } from './difficulty-controller';
import { deriveAsrState, mapYtCategory } from './sensor-signals';
import type { OriginalTitleDetail } from './sensor-signals';
import { showUpdateNotification } from '../../lib/update-notification';
import { claimContentScript } from '../../lib/content-guard';
import { sampleAttention } from '../../lib/attention';
import { playbackDeltaMs } from '../../lib/playback-delta';
import { collectUIState, startAdDebugObserver } from './debug-ui';
import { readWatchOwner, ownerUrlFromPlayer, channelIdFromUrl } from './channel-owner';

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',

  main() {
    if (!claimContentScript('youtube')) return;
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
    let videoAudioLanguage: string | null = null;
    let videoDescription: string | null = null;
    let videoAuthor: string | null = null;
    let videoChannelId: string | null = null;
    let videoOwnerUrl: string | null = null;
    let videoCategoryRaw: string | null = null;
    let videoIsLive: boolean | null = null;
    let videoResponseRead = false;
    let originalTitleVideoId: string | null = null;
    let originalTitleRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let originalTitleResponsePending = false;
    let useOriginalTitles = false;
    let trackJapaneseOnly = false;
    let whitelistedChannels: WhitelistedChannel[] = [];
    let blockedChannels: BlockedChannel[] = [];
    const DEDUP_WINDOW_MS = 200;
    let lastVideoTime = 0;
    let lastTickAt = 0;
    let accumulatedDeltaMs = 0;
    let pauseDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let currentSessionId: string | null = null;
    let currentSessionVideoId: string | null = null;
    let playGeneration = 0;
    let boundVideoEvents: Array<[string, EventListener]> = [];
    let boundVideoTarget: HTMLVideoElement | null = null;

    document.querySelectorAll('video[data-jp343-tracked]').forEach(v => {
      v.removeAttribute('data-jp343-tracked');
    });

    const observers: MutationObserver[] = [];
    const intervalIds: ReturnType<typeof setInterval>[] = [];
    function cleanup(): void {
      hideDifficultyChip();
      stopFeedBadges();
      detachVideoEvents();
      observers.forEach(o => o.disconnect());
      intervalIds.forEach(clearInterval);
      observers.length = 0;
      intervalIds.length = 0;
      stateUpdateInterval = null;
      adCheckInterval = null;
      if (originalTitleRetryTimer) clearTimeout(originalTitleRetryTimer);
      pendingRetryTimeouts.forEach(clearTimeout);
      pendingRetryTimeouts = [];
      window.removeEventListener('jp343-original-title', handleOriginalTitleResponse);
    }
    window.addEventListener('pagehide', () => {
      if (lastVideoUrl && isWatchUrl(lastVideoUrl)) {
        flushDelta();
        sendVideoEnded();
      }
      cleanup();
    });
    window.addEventListener('pageshow', (e) => {
      if (e.persisted && isExtensionContextValid() && isWatchPath(window.location.pathname)) {
        tryInitialVideoAttach();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (!extensionContextValid) return;
      if (document.hidden) {
        flushDelta();
      }
      if (!document.hidden) {
        const video = currentVideoElement;
        if (!video) return;
        if (video.ended) {
          sendVideoEnded();
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
      flushDelta();
      accumulatedDeltaMs = 0;
      const generation = ++playGeneration;
      const requestedVideoId = state.videoId;
      sendMessage('VIDEO_PLAY', { state }).then(response => {
        if (generation !== playGeneration) return;
        if (response && typeof response === 'object' && 'sessionId' in response) {
          currentSessionId = (response as { sessionId: string }).sessionId;
          currentSessionVideoId = requestedVideoId;
        }
      });
      sendDiagnostic('video_play_sent');
      sendDiagnostic(state.title && state.title !== 'YouTube Video' ? 'metadata_found' : 'metadata_missing');
    }

    function sendVideoEnded(): void {
      const sessionId = currentSessionId;
      const videoId = currentSessionVideoId;
      const state = getCurrentVideoState();
      const payload: Record<string, unknown> = {};
      if (state) payload.state = state;
      if (sessionId) payload.sessionId = sessionId;
      if (videoId) payload.videoId = videoId;
      void sendMessage('VIDEO_ENDED', payload).then(() => {
        if (currentSessionId !== sessionId) return;
        currentSessionId = null;
        currentSessionVideoId = null;
      });
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

    function getVideoDurationSec(): number | null {
      const duration = findVideoElement()?.duration;
      return typeof duration === 'number' && Number.isFinite(duration) && duration > 0
        ? Math.round(duration)
        : null;
    }

    initDifficulty({ getVideoId, getVideoTitle, getChannelInfo, getJapaneseSignal, getVideoDurationSec, sendMessage });

    browser.runtime.sendMessage({ type: 'GET_SETTINGS' }).then((response) => {
      if (response?.success && response.data?.settings) {
        const prev = useOriginalTitles;
        useOriginalTitles = response.data.settings.useOriginalTitles ?? false;
        trackJapaneseOnly = response.data.settings.trackJapaneseOnly ?? true;
        whitelistedChannels = response.data.settings.whitelistedChannels ?? [];
        blockedChannels = response.data.settings.blockedChannels ?? [];
        if (useOriginalTitles !== prev) onOriginalTitleSettingChanged();
        applyDifficultySettings(
          response.data.settings.showDifficultyLevels ?? true,
          response.data.settings.difficultyLocalOnly ?? false,
          response.data.settings.difficultyVotingEnabled ?? true
        );
      }
    }).catch(() => {});

    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[STORAGE_KEYS.SETTINGS]?.newValue) {
        const prev = useOriginalTitles;
        useOriginalTitles = changes[STORAGE_KEYS.SETTINGS].newValue.useOriginalTitles ?? false;
        trackJapaneseOnly = changes[STORAGE_KEYS.SETTINGS].newValue.trackJapaneseOnly ?? true;
        whitelistedChannels = changes[STORAGE_KEYS.SETTINGS].newValue.whitelistedChannels ?? [];
        blockedChannels = changes[STORAGE_KEYS.SETTINGS].newValue.blockedChannels ?? [];
        const settingsValue = changes[STORAGE_KEYS.SETTINGS].newValue as ExtensionSettings;
        if (useOriginalTitles !== prev) onOriginalTitleSettingChanged();
        applyDifficultySettings(
          settingsValue.showDifficultyLevels ?? true,
          settingsValue.difficultyLocalOnly ?? false,
          settingsValue.difficultyVotingEnabled ?? true
        );
        checkTrackingToast();
      }
      handleDifficultyStorageChange(changes);
    });

    if (DEBUG_MODE) { setupDebugCommands(logger, 'youtube'); }

    if (DEBUG_MODE) observers.push(startAdDebugObserver(debugLog));

    function isExtensionContextValid(): boolean {
      if (!extensionContextValid) return false;
      try {
        if (browser.runtime?.id) return true;
      } catch { /* context gone */ }
      invalidateExtensionContext();
      return false;
    }

    function invalidateExtensionContext(): void {
      if (extensionContextValid) {
        log('[JP343] Extension context invalid - stopping tracking');
        debugLog('CONTEXT', 'Extension context invalid - stopping tracking');
        extensionContextValid = false;
        showUpdateNotification();
        if (adCheckInterval) {
          clearInterval(adCheckInterval);
          adCheckInterval = null;
        }
        if (stateUpdateInterval) {
          clearInterval(stateUpdateInterval);
          stateUpdateInterval = null;
        }
        detachVideoEvents(true);
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

    // player data first, then the owner of this video
    function getChannelInfo(): { id: string | null; name: string | null; url: string | null } {
      const videoId = getVideoId();
      const fromPlayer = videoId !== null && originalTitleVideoId === videoId;
      const owner = readWatchOwner(videoId);
      const name = (fromPlayer && videoAuthor) || owner.name;
      const url = (fromPlayer && videoOwnerUrl) || owner.url;
      const id = (fromPlayer && videoChannelId) || channelIdFromUrl(url);
      return { id, name, url };
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
      const detail = (e as CustomEvent<OriginalTitleDetail>).detail;
      if (!detail) return;
      if (detail.videoId !== originalTitleVideoId) return;
      let gotSignal = false;
      if (typeof detail.audioLang === 'string' && detail.audioLang) {
        videoAudioLanguage = detail.audioLang;
        gotSignal = true;
      }
      if (typeof detail.desc === 'string' && detail.desc) {
        videoDescription = detail.desc;
      }
      if (typeof detail.author === 'string' && detail.author) {
        videoAuthor = detail.author;
        gotSignal = true;
      }
      if (typeof detail.channelId === 'string' && detail.channelId.startsWith('UC')) {
        videoChannelId = detail.channelId;
      }
      const ownerUrl = ownerUrlFromPlayer(detail.ownerUrl);
      if (ownerUrl) videoOwnerUrl = ownerUrl;
      if (!videoCategoryRaw && typeof detail.category === 'string' && detail.category) {
        videoCategoryRaw = detail.category;
        gotSignal = true;
      }
      if (videoIsLive === null && typeof detail.isLive === 'boolean') {
        videoIsLive = detail.isLive;
      }
      if (detail.responseRead === true) videoResponseRead = true;
      if (detail.title && typeof detail.title === 'string') {
        originalTitle = detail.title;
        log('[JP343] Original title:', originalTitle);
        sendDiagnostic('original_title_success');
        gotSignal = true;
      }
      if (gotSignal) {
        originalTitleResponsePending = false;
        const state = getCurrentVideoState();
        if (state && state.isPlaying && !state.isAd) {
          sendMessage('VIDEO_STATE_UPDATE', { state });
        }
        updateDifficultyChip();
      }
      checkTrackingToast();
    }

    window.addEventListener('jp343-original-title', handleOriginalTitleResponse);

    function requestOriginalTitle(videoId: string | null): void {
      if (!videoId) {
        originalTitle = null;
        videoAudioLanguage = null;
        videoDescription = null;
        videoAuthor = null;
        videoChannelId = null;
        videoOwnerUrl = null;
        videoCategoryRaw = null;
        videoIsLive = null;
        videoResponseRead = false;
        originalTitleVideoId = null;
        originalTitleResponsePending = false;
        return;
      }
      // same video on resume: keep player data
      if (videoId !== originalTitleVideoId) {
        originalTitle = null;
        videoAudioLanguage = null;
        videoDescription = null;
        videoAuthor = null;
        videoChannelId = null;
        videoOwnerUrl = null;
        videoCategoryRaw = null;
        videoIsLive = null;
        videoResponseRead = false;
      }
      originalTitleVideoId = videoId;
      // only while the retry chain below runs
      originalTitleResponsePending = !originalTitle || !videoAudioLanguage;
      if (originalTitleRetryTimer) {
        clearTimeout(originalTitleRetryTimer);
        originalTitleRetryTimer = null;
      }
      attemptOriginalTitle(videoId, 0);
    }

    function attemptOriginalTitle(videoId: string | null, attempt: number): void {
      if (attempt >= 3) {
        originalTitleResponsePending = false;
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
      if (!originalTitle || !videoAudioLanguage) {
        originalTitleRetryTimer = setTimeout(() => attemptOriginalTitle(videoId, attempt + 1), 1000);
      }
    }

    function checkTrackingToast(): void {
      if (!trackJapaneseOnly) { hideTrackingToast(); return; }
      if (originalTitleResponsePending && originalTitleVideoId === getVideoId()) return;
      const state = getCurrentVideoState();

      if (state?.channelId) {
        if (isChannelInList(whitelistedChannels, state.channelId, state.channelUrl)) { hideTrackingToast(); return; }
        if (isChannelInList(blockedChannels, state.channelId, state.channelUrl)) { hideTrackingToast(); return; }
      }

      if (isToastActive()) return;

      if (!state || state.isAd) return;
      if (!state.channelId || !state.channelName) return;
      if (isLikelyJapaneseVideo(state)) return;
      // require a reliable title signal
      if (!state.originalTitle && !isJapaneseLanguageCode(state.audioLanguage)) return;
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

    function getJapaneseSignal(): boolean | null {
      const channelInfo = getChannelInfo();
      const signals = {
        title: getVideoTitle(),
        originalTitle: originalTitleVideoId === getVideoId() ? originalTitle : null,
        channelName: channelInfo.name,
        audioLanguage: videoAudioLanguage,
        description: videoDescription
      };
      if (isLikelyJapaneseVideo(signals)) return true;
      if (originalTitleResponsePending && originalTitleVideoId === getVideoId()) return null;
      return false;
    }

    function getCurrentVideoState(): VideoState | null {
      const video = findVideoElement();
      if (!video) return null;

      const videoId = getVideoId();
      if (!videoId && !isWatchPath(window.location.pathname)) {
        return null;
      }

      const channelInfo = getChannelInfo();
      const localEstimate = getLocalSensorEstimate(videoId);

      return {
        isPlaying: !video.paused && !video.ended,
        currentTime: video.currentTime,
        duration: video.duration || 0,
        title: (useOriginalTitles && originalTitleVideoId === videoId && originalTitle) || getVideoTitle(),
        url: canonicalWatchUrl(window.location.href),
        platform: 'youtube',
        isAd: isAdPlaying(),
        thumbnailUrl: videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : null,
        videoId: videoId,
        channelId: channelInfo.id,
        channelName: channelInfo.name,
        channelUrl: channelInfo.url,
        originalTitle: (originalTitleVideoId === videoId && originalTitle) || null,
        audioLanguage: videoAudioLanguage,
        description: videoDescription,
        asrState: deriveAsrState(videoAudioLanguage, videoResponseRead),
        ytCategory: mapYtCategory(videoCategoryRaw),
        isLive: videoIsLive,
        estimateState: localEstimate?.estimateState ?? null,
        speechRatio: localEstimate?.speechRatio ?? null
      };
    }

    function flushDelta(): void {
      if (accumulatedDeltaMs <= 0 || !currentSessionId) return;
      const ms = accumulatedDeltaMs;
      accumulatedDeltaMs = 0;
      sendMessage('TIME_DELTA', { deltaMs: Math.round(ms), sessionId: currentSessionId, attention: sampleAttention() });
    }

    async function sendMessage(type: string, data?: Record<string, unknown>): Promise<unknown> {
      if (!isExtensionContextValid()) return;

      try {
        return await browser.runtime.sendMessage({
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
        return undefined;
      }
    }

    function detachVideoEvents(keepMarker = false): void {
      if (!boundVideoTarget) return;
      for (const [type, handler] of boundVideoEvents) {
        boundVideoTarget.removeEventListener(type, handler);
      }
      boundVideoEvents = [];
      if (!keepMarker) boundVideoTarget.removeAttribute('data-jp343-tracked');
      boundVideoTarget = null;
    }

    function attachVideoEvents(video: HTMLVideoElement): void {
      if (window.location.pathname.startsWith('/shorts/')) return;
      if (boundVideoTarget === video) { ensureStateUpdates(); syncAlreadyPlaying(video); return; }
      detachVideoEvents();
      video.setAttribute('data-jp343-tracked', 'true');
      boundVideoTarget = video;
      const on = (type: string, handler: EventListener): void => {
        video.addEventListener(type, handler);
        boundVideoEvents.push([type, handler]);
      };

      on('play', () => {
        if (!isExtensionContextValid()) return;
        if (video !== currentVideoElement) return;
        if (pauseDebounceTimer) { clearTimeout(pauseDebounceTimer); pauseDebounceTimer = null; sendDiagnostic('pause_debounced'); }
        lastVideoTime = video.currentTime;
        lastTickAt = performance.now();
        flushDelta();
        accumulatedDeltaMs = 0;
        if (DEBUG_MODE) debugLog('VIDEO_PLAY', '=== VIDEO PLAY EVENT ===', collectUIState(isCurrentlyAd, extensionContextValid));
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
          pendingRetryTimeouts.push(setTimeout(updateDifficultyChip, 2500));

          const initialChannelId = state.channelId;
          const retryDelays = [2000, 4000, 8000];
          let retryIndex = 0;
          const recheckChannel = (): void => {
            if (retryIndex >= retryDelays.length || !isExtensionContextValid()) return;
            pendingRetryTimeouts.push(setTimeout(() => {
              const freshState = getCurrentVideoState();
              if (freshState?.channelId && freshState.channelId !== initialChannelId) {
                sendMessage('VIDEO_STATE_UPDATE', { state: freshState });
                return;
              }
              retryIndex++;
              recheckChannel();
            }, retryDelays[retryIndex]));
          };
          recheckChannel();
        }
      });

      on('pause', () => {
        if (!isExtensionContextValid()) return;
        if (video !== currentVideoElement) return;
        if (DEBUG_MODE) debugLog('VIDEO_PAUSE', '=== VIDEO PAUSE EVENT ===', collectUIState(isCurrentlyAd, extensionContextValid));
        flushDelta();
        if (pauseDebounceTimer) clearTimeout(pauseDebounceTimer);
        pauseDebounceTimer = setTimeout(() => {
          pauseDebounceTimer = null;
          if (video.paused && !video.ended) {
            sendVideoPause();
          }
        }, 300);
      });

      on('ended', () => {
        if (!isExtensionContextValid()) return;
        if (video !== currentVideoElement) return;
        if (DEBUG_MODE) debugLog('VIDEO_ENDED', '=== VIDEO ENDED EVENT ===', collectUIState(isCurrentlyAd, extensionContextValid));
        flushDelta();
        sendVideoEnded();
        hideTrackingToast();
      });

      on('waiting', () => {
        if (!isExtensionContextValid()) return;
        if (video !== currentVideoElement) return;
        if (!isCurrentlyAd) {
          flushDelta();
        }
      });

      on('emptied', () => {
        if (!isExtensionContextValid()) return;
        if (video !== currentVideoElement) return;
        if (document.hidden && video.paused && video.readyState === 0) {
          flushDelta();
          sendVideoPause();
        }
      });

      on('playing', () => {
        if (!isExtensionContextValid()) return;
        if (video !== currentVideoElement) return;
        if (pauseDebounceTimer) { clearTimeout(pauseDebounceTimer); pauseDebounceTimer = null; sendDiagnostic('pause_debounced'); }
        lastVideoTime = video.currentTime;
        lastTickAt = performance.now();
        flushDelta();
        accumulatedDeltaMs = 0;
        const state = getCurrentVideoState();
        if (state && !state.isAd) {
          sendVideoPlay(state);
        }
      });

      on('timeupdate', () => {
        if (!isExtensionContextValid()) return;
        if (isCurrentlyAd) return;
        if (video.paused || video.ended) return;
        const ct = video.currentTime;
        const now = performance.now();
        const ms = playbackDeltaMs(ct - lastVideoTime, now - lastTickAt, video.playbackRate);
        lastVideoTime = ct;
        lastTickAt = now;
        if (ms > 0) {
          accumulatedDeltaMs += ms;
          if (accumulatedDeltaMs >= 10_000) {
            flushDelta();
          }
        }
      });

      ensureStateUpdates();

      debugLog('INIT', 'Video events bound', { src: video.src?.slice(0, 80) });
      log('[JP343] Video events bound');

      syncAlreadyPlaying(video);
    }

    function ensureStateUpdates(): void {
      if (stateUpdateInterval) return;
      stateUpdateInterval = setInterval(() => {
        if (!isExtensionContextValid()) return;
        const state = getCurrentVideoState();
        if (state && state.isPlaying && !state.isAd) {
          sendMessage('VIDEO_STATE_UPDATE', { state });
        }
      }, 30000);
      intervalIds.push(stateUpdateInterval);
    }

    function syncAlreadyPlaying(video: HTMLVideoElement): void {
      pendingRetryTimeouts.push(setTimeout(() => {
        if (!isExtensionContextValid()) return;
        if (!video.paused && !video.ended) {
          const videoId = getVideoId();
          if (videoId && originalTitleVideoId !== videoId) {
            requestOriginalTitle(videoId);
          }
          const state = getCurrentVideoState();
          if (state && !state.isAd) {
            if (DEBUG_MODE) debugLog('VIDEO_PLAY', 'Video already playing - starting tracking', collectUIState(isCurrentlyAd, extensionContextValid));
            log('[JP343] Video already playing - starting tracking');
            sendVideoPlay(state);
          }
        }
      }, 500));
    }

    let lastAdState = false;
    function startAdMonitoring(): void {
      if (adCheckInterval) return;

      adCheckInterval = setInterval(() => {
        if (!isExtensionContextValid()) return;

        const isAd = isAdPlaying();

        if (DEBUG_MODE && isAd !== lastAdState) {
          lastAdState = isAd;
          if (isAd) {
            debugLog('AD_STATE', '=== AD STARTED ===', collectUIState(isCurrentlyAd, extensionContextValid));
          } else {
            debugLog('AD_STATE', '=== AD ENDED ===', collectUIState(isCurrentlyAd, extensionContextValid));
          }
        }

        if (isAd && !isCurrentlyAd) {
          flushDelta();
          lastVideoTime = 0;
          lastTickAt = performance.now();
          isCurrentlyAd = true;
          sendMessage('AD_START');
        } else if (!isAd && isCurrentlyAd) {
          isCurrentlyAd = false;
          lastVideoTime = 0;
          lastTickAt = performance.now();
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

        if (lastVideoUrl && isWatchUrl(lastVideoUrl)) {
          log('[JP343] URL change - ending previous session');
          flushDelta();
          sendVideoEnded();
        }

        hideTrackingToast();
        hideDifficultyChip();
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
        videoAudioLanguage = null;
        videoDescription = null;
        videoAuthor = null;
        videoChannelId = null;
        videoOwnerUrl = null;
        videoCategoryRaw = null;
        videoIsLive = null;
        videoResponseRead = false;
        originalTitleResponsePending = false;

        // YT reuses the video node across watch pages
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
          pendingRetryTimeouts.push(setTimeout(updateDifficultyChip, 1500));
        }, 1000);
      }
    }

    if (DEBUG_MODE) {
      const periodicCheckId = setInterval(() => {
        const video = findVideoElement();
        if (video && !video.paused) {
          debugLog('PERIODIC', 'Periodic state check', collectUIState(isCurrentlyAd, extensionContextValid));
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

    if (isWatchPath(window.location.pathname)) {
      tryInitialVideoAttach();
    }

    const videoPollingId = setInterval(() => {
      if (!isExtensionContextValid()) return;
      if (window.location.href !== lastVideoUrl) {
        handleUrlChange();
        return;
      }
      if (currentVideoElement && currentVideoElement.isConnected) return;
      if (!isWatchPath(window.location.pathname)) return;

      const video = findVideoElement();
      if (video) {
        currentVideoElement = video;
        attachVideoEvents(video);
        startAdMonitoring();
        sendDiagnostic('player_found');
      }
    }, 2000);
    intervalIds.push(videoPollingId);

    const chipKeepAliveId = setInterval(() => {
      if (!isWatchPath(window.location.pathname)) return;
      if (!isDifficultyChipMounted()) updateDifficultyChip();
    }, 4000);
    intervalIds.push(chipKeepAliveId);

    const voteGatePollId = setInterval(pollLocalVoteGate, 5000);
    intervalIds.push(voteGatePollId);

    window.addEventListener('popstate', () => setTimeout(handleUrlChange, 100));

    document.addEventListener('yt-navigate-start', () => hideDifficultyChip());

    document.addEventListener('yt-navigate-finish', () => {
      setTimeout(handleUrlChange, 100);
      scheduleFeedBadgeSweep();
    });

    lastVideoUrl = window.location.href;

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
        if (!extensionContextValid) return;
        const video = currentVideoElement;
        if (!video) return;
        if (video.ended) {
          sendVideoEnded();
        } else if (!video.paused && !video.ended) {
          const state = getCurrentVideoState();
          if (state && !state.isAd) {
            sendVideoPlay(state);
          }
        } else if (video.paused) {
          sendVideoPause();
        }
      }
      return undefined;
    });

    debugLog('INIT', 'YouTube Content Script fully initialized', {
      url: window.location.href,
      isWatchPage: isWatchPath(window.location.pathname)
    });
  }
});
