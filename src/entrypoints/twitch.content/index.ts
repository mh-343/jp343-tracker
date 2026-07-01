import type { VideoState } from '../../types';
import { createDebugLogger, setupDebugCommands, DEBUG_MODE } from '../../lib/debug-logger';
import { showUpdateNotification } from '../../lib/update-notification';
import { claimContentScript } from '../../lib/content-guard';
import { parseChannelLogin, parseTwitchMetaEvent, type TwitchMetaEvent } from './twitch-parsers';

export default defineContentScript({
  matches: ['*://*.twitch.tv/*'],
  runAt: 'document_idle',

  main() {
    if (!claimContentScript('twitch')) return;
    let currentVideoElement: HTMLVideoElement | null = null;
    let currentLogin: string | null = null;
    let twitchMeta: TwitchMetaEvent | null = null;
    let metaPending = false;
    let wantTrack = false;
    let lastVideoTime = 0;
    let accumulatedDeltaMs = 0;
    let currentSessionId: string | null = null;
    let tracking = false;
    let pauseDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let videoUpdateIntervalId: ReturnType<typeof setInterval> | null = null;
    let lastMetaFetchAt = 0;
    let adActive = false;
    let lastPlaySentAt = 0;
    let pickUpScheduled = false;

    const observers: MutationObserver[] = [];
    const intervalIds: ReturnType<typeof setInterval>[] = [];
    function cleanup(): void {
      window.removeEventListener('jp343-twitch-meta', handleTwitchMeta);
      observers.forEach(o => o.disconnect());
      intervalIds.forEach(clearInterval);
      if (videoUpdateIntervalId !== null) { clearInterval(videoUpdateIntervalId); videoUpdateIntervalId = null; }
      observers.length = 0;
      intervalIds.length = 0;
    }

    window.addEventListener('pagehide', () => {
      if (tracking) {
        flushDelta();
        endAdIfActive();
        sendMessage('VIDEO_ENDED');
      }
      cleanup();
    });

    const logger = createDebugLogger('twitch');
    const { log, debugLog } = logger;
    log('[JP343] Twitch content script loaded');
    if (DEBUG_MODE) { setupDebugCommands(logger, 'twitch', { logStatus: false }); }

    const isIncognito = browser.extension?.inIncognitoContext ?? false;
    function sendDiagnostic(code: string): void {
      if (isIncognito) return;
      try {
        browser.runtime.sendMessage({ type: 'DIAGNOSTIC_EVENT', code, platform: 'twitch' }).catch(() => {});
      } catch { /* best-effort */ }
    }

    async function sendMessage(type: string, data?: Record<string, unknown>): Promise<unknown> {
      try {
        return await browser.runtime.sendMessage({ type, platform: 'twitch', ...data });
      } catch (error) {
        if (error instanceof Error && error.message.includes('Extension context invalidated')) {
          showUpdateNotification();
          return;
        }
        log('[JP343] Twitch: Message error:', error);
        return undefined;
      }
    }

    function sendVideoPlay(state: VideoState): void {
      const now = Date.now();
      if (now - lastPlaySentAt < 700) return;
      lastPlaySentAt = now;
      flushDelta();
      accumulatedDeltaMs = 0;
      tracking = true;
      sendMessage('VIDEO_PLAY', { state }).then(response => {
        if (response && typeof response === 'object' && 'sessionId' in response) {
          currentSessionId = (response as { sessionId: string }).sessionId;
        }
      });
      sendDiagnostic('video_play_sent');
      syncAdState();
    }

    function flushDelta(): void {
      if (accumulatedDeltaMs <= 0 || !currentSessionId) return;
      const ms = accumulatedDeltaMs;
      accumulatedDeltaMs = 0;
      sendMessage('TIME_DELTA', { deltaMs: Math.round(ms), sessionId: currentSessionId });
    }

    function endAdIfActive(): void {
      if (adActive) { adActive = false; sendMessage('AD_END'); }
    }

    function syncAdState(): void {
      const ad = isAdPlaying();
      if (ad === adActive) return;
      adActive = ad;
      if (ad) flushDelta();
      if (currentVideoElement) lastVideoTime = currentVideoElement.currentTime;
      sendMessage(ad ? 'AD_START' : 'AD_END');
    }

    function findVideoElement(): HTMLVideoElement | null {
      return (document.querySelector('[data-a-target="video-player"] video') as HTMLVideoElement)
        || (document.querySelector('.video-player__container video') as HTMLVideoElement)
        || (document.querySelector('.persistent-player video') as HTMLVideoElement)
        || (document.querySelector('video') as HTMLVideoElement)
        || null;
    }

    function isAdPlaying(): boolean {
      return !!document.querySelector('[data-a-target="video-ad-countdown"], [data-a-target="video-ad-label"]');
    }

    function requestMetaIfNeeded(): void {
      if (!currentLogin || twitchMeta || metaPending) return;
      metaPending = true;
      lastMetaFetchAt = Date.now();
      try {
        const script = document.createElement('script');
        script.src = browser.runtime.getURL('/inject-twitch-meta.js');
        script.onerror = () => { metaPending = false; };
        document.documentElement.appendChild(script);
      } catch {
        metaPending = false;
        log('[JP343] Twitch: Failed to inject meta script');
      }
    }

    function handleTwitchMeta(e: Event): void {
      const meta = parseTwitchMetaEvent((e as CustomEvent<unknown>).detail);
      if (!meta) { metaPending = false; return; }
      if (meta.login !== currentLogin) return;
      metaPending = false;
      twitchMeta = meta;
      log('[JP343] Twitch meta:', meta.channelName, meta.language, meta.isLive ? 'live' : 'offline');
      if (wantTrack) attemptTrack();
    }
    window.addEventListener('jp343-twitch-meta', handleTwitchMeta);

    function setChannel(login: string | null): void {
      if (login === currentLogin) return;
      if (pauseDebounceTimer) { clearTimeout(pauseDebounceTimer); pauseDebounceTimer = null; }
      endAdIfActive();
      if (tracking) { flushDelta(); sendMessage('VIDEO_ENDED'); }
      tracking = false;
      currentSessionId = null;
      currentLogin = login;
      twitchMeta = null;
      metaPending = false;
      wantTrack = false;
      if (login) requestMetaIfNeeded();
    }

    function getCurrentVideoState(): VideoState | null {
      const video = findVideoElement();
      if (!video || !currentLogin) return null;
      return {
        isPlaying: !video.paused && !video.ended,
        currentTime: video.currentTime,
        duration: isFinite(video.duration) ? video.duration : 0,
        title: twitchMeta?.title || document.title,
        url: window.location.href,
        platform: 'twitch',
        isAd: isAdPlaying(),
        thumbnailUrl: twitchMeta?.thumbnail || null,
        videoId: currentLogin,
        channelId: currentLogin,
        channelName: twitchMeta?.channelName || currentLogin,
        channelUrl: `https://www.twitch.tv/${currentLogin}`,
        audioLanguage: twitchMeta?.language || null
      };
    }

    function attemptTrack(): void {
      if (currentLogin === null) return;
      const video = findVideoElement();
      if (!video || video.paused || video.ended) return;
      if (!twitchMeta) { wantTrack = true; requestMetaIfNeeded(); return; }
      if (!twitchMeta.isLive) {
        if (Date.now() - lastMetaFetchAt > 30000) {
          twitchMeta = null;
          wantTrack = true;
          requestMetaIfNeeded();
        }
        return;
      }
      const state = getCurrentVideoState();
      if (!state) return;
      lastVideoTime = video.currentTime;
      wantTrack = false;
      log('[JP343] Twitch play:', state.channelName);
      sendVideoPlay(state);
    }

    function attachVideoEvents(video: HTMLVideoElement): void {
      if (video.hasAttribute('data-jp343-tracked')) return;
      video.setAttribute('data-jp343-tracked', 'true');

      video.addEventListener('play', () => {
        if (pauseDebounceTimer) { clearTimeout(pauseDebounceTimer); pauseDebounceTimer = null; }
        lastVideoTime = video.currentTime;
        flushDelta();
        accumulatedDeltaMs = 0;
        attemptTrack();
      });

      video.addEventListener('playing', () => {
        if (pauseDebounceTimer) { clearTimeout(pauseDebounceTimer); pauseDebounceTimer = null; }
        lastVideoTime = video.currentTime;
        flushDelta();
        accumulatedDeltaMs = 0;
        attemptTrack();
      });

      video.addEventListener('pause', () => {
        flushDelta();
        if (!tracking) return;
        if (pauseDebounceTimer) clearTimeout(pauseDebounceTimer);
        pauseDebounceTimer = setTimeout(() => {
          pauseDebounceTimer = null;
          if (video.paused && !video.ended) sendMessage('VIDEO_PAUSE');
        }, 300);
      });

      video.addEventListener('ended', () => {
        flushDelta();
        endAdIfActive();
        if (tracking) sendMessage('VIDEO_ENDED');
        tracking = false;
      });

      video.addEventListener('waiting', () => { flushDelta(); });

      video.addEventListener('timeupdate', () => {
        if (video.paused || video.ended || !tracking) return;
        syncAdState();
        const ct = video.currentTime;
        const d = ct - lastVideoTime;
        lastVideoTime = ct;
        if (adActive) return;
        if (d > 0 && d <= 10) {
          const realDelta = d / (video.playbackRate || 1);
          accumulatedDeltaMs += realDelta * 1000;
          if (accumulatedDeltaMs >= 10_000) flushDelta();
        }
      });

      if (videoUpdateIntervalId !== null) clearInterval(videoUpdateIntervalId);
      videoUpdateIntervalId = setInterval(() => {
        if (!tracking) return;
        const state = getCurrentVideoState();
        if (state && state.isPlaying) {
          sendMessage('VIDEO_STATE_UPDATE', { state });
        }
      }, 30000);

      log('[JP343] Twitch: Events bound');
      sendDiagnostic('player_found');
    }

    function syncChannelFromUrl(): void {
      setChannel(parseChannelLogin(window.location.pathname));
    }

    function pickUpVideo(): void {
      if (!currentLogin) return;
      const video = findVideoElement();
      if (!video) return;
      const isNew = video !== currentVideoElement;
      if (isNew) {
        currentVideoElement = video;
        attachVideoEvents(video);
      }
      if ((isNew || !tracking) && !video.paused && !video.ended) attemptTrack();
    }

    const observer = new MutationObserver(() => {
      if (!currentLogin || pickUpScheduled) return;
      pickUpScheduled = true;
      setTimeout(() => { pickUpScheduled = false; pickUpVideo(); }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    observers.push(observer);

    syncChannelFromUrl();
    pickUpVideo();

    let lastUrl = window.location.href;
    intervalIds.push(setInterval(() => {
      if (window.location.href !== lastUrl) {
        const oldUrl = lastUrl;
        lastUrl = window.location.href;
        debugLog('URL_CHANGE', 'URL changed', { oldUrl, newUrl: lastUrl });
        syncChannelFromUrl();
        currentVideoElement = null;
        setTimeout(pickUpVideo, 500);
      } else if (currentLogin && !tracking) {
        pickUpVideo();
      }
    }, 1000));

    intervalIds.push(setInterval(() => {
      if (tracking && currentVideoElement && !currentVideoElement.paused && !currentVideoElement.ended) syncAdState();
    }, 2000));

    setTimeout(pickUpVideo, 3000);

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
        pickUpVideo();
      }
      return undefined;
    });
  }
});
