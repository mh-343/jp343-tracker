import type { VideoState } from '../../types';
import { createDebugLogger, setupDebugCommands, DEBUG_MODE } from '../../lib/debug-logger';
import { showUpdateNotification } from '../../lib/update-notification';

// nihongo-jikan.com embeds each lesson via a www.youtube.com/embed iframe.
// This tracker runs inside that iframe (allFrames) and only acts when the
// embedding page is nihongo-jikan.com, so generic YouTube embeds elsewhere
// are never tracked as this platform.
const PARENT_HOST = 'nihongo-jikan.com';

function hostMatches(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === PARENT_HOST || host.endsWith('.' + PARENT_HOST);
  } catch {
    return false;
  }
}

function resolveParentPageUrl(): string | null {
  const params = new URLSearchParams(location.search);
  const forigin = params.get('forigin') || '';
  const origin = params.get('origin') || '';
  const referrer = document.referrer || '';
  let ancestor = '';
  const ancestors = location.ancestorOrigins;
  if (ancestors && ancestors.length) ancestor = ancestors[0];

  const candidates = [forigin, referrer, origin, ancestor];
  if (!candidates.some(c => c && hostMatches(c))) return null;
  // Prefer a candidate that carries the /videos/<id> path
  return candidates.find(c => c && hostMatches(c) && /\/videos?\//.test(c))
    || candidates.find(c => c && hostMatches(c))
    || null;
}

export default defineContentScript({
  matches: ['*://*.youtube.com/embed/*'],
  allFrames: true,
  runAt: 'document_idle',

  main() {
    if (window.top === window.self) return;
    const parentPageUrl = resolveParentPageUrl();
    if (!parentPageUrl) return;

    const youtubeId = (location.pathname.match(/\/embed\/([^/?#]+)/) || [])[1] || null;
    const numericId = (parentPageUrl.match(/\/videos?\/(\d+)/) || [])[1] || null;
    const videoId = numericId || youtubeId;
    const pageUrl = /\/videos?\//.test(parentPageUrl) ? parentPageUrl : `https://${PARENT_HOST}/`;

    let currentVideoElement: HTMLVideoElement | null = null;
    let lastVideoTime = 0;
    let accumulatedDeltaMs = 0;
    let currentSessionId: string | null = null;
    let tracking = false;
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
      if (tracking) { flushDelta(); sendMessage('VIDEO_ENDED'); }
      cleanup();
    });

    const logger = createDebugLogger('nihongojikan');
    const { log } = logger;
    log('[JP343] Nihongo no Jikan embed:', pageUrl, videoId);
    if (DEBUG_MODE) { setupDebugCommands(logger, 'nihongojikan', { logStatus: false }); }

    const isIncognito = browser.extension?.inIncognitoContext ?? false;
    function sendDiagnostic(code: string): void {
      if (isIncognito) return;
      try {
        browser.runtime.sendMessage({ type: 'DIAGNOSTIC_EVENT', code, platform: 'nihongojikan' }).catch(() => {});
      } catch { /* best-effort */ }
    }

    async function sendMessage(type: string, data?: Record<string, unknown>): Promise<unknown> {
      try {
        return await browser.runtime.sendMessage({ type, platform: 'nihongojikan', ...data });
      } catch (error) {
        if (error instanceof Error && error.message.includes('Extension context invalidated')) {
          showUpdateNotification();
          return;
        }
        log('[JP343] Nihongo no Jikan: Message error:', error);
        return undefined;
      }
    }

    function getTitle(): string {
      const link = document.querySelector('.ytp-title-link');
      const linkText = link?.textContent?.trim();
      if (linkText && linkText.length > 1) return linkText;
      const docTitle = document.title.replace(/\s*-\s*YouTube\s*$/i, '').trim();
      if (docTitle && docTitle.length > 1) return docTitle;
      return 'Nihongo no Jikan Content';
    }

    function getCurrentVideoState(video: HTMLVideoElement): VideoState {
      return {
        isPlaying: !video.paused && !video.ended,
        currentTime: video.currentTime,
        duration: isFinite(video.duration) ? video.duration : 0,
        title: getTitle(),
        url: pageUrl,
        platform: 'nihongojikan',
        isAd: false,
        thumbnailUrl: youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg` : null,
        videoId: videoId,
        channelId: 'nihongojikan',
        channelName: 'Nihongo no Jikan',
        channelUrl: `https://${PARENT_HOST}`
      };
    }

    function flushDelta(): void {
      if (accumulatedDeltaMs <= 0 || !currentSessionId) return;
      const ms = accumulatedDeltaMs;
      accumulatedDeltaMs = 0;
      sendMessage('TIME_DELTA', { deltaMs: Math.round(ms), sessionId: currentSessionId });
    }

    function sendVideoPlay(video: HTMLVideoElement): void {
      flushDelta();
      accumulatedDeltaMs = 0;
      tracking = true;
      sendMessage('VIDEO_PLAY', { state: getCurrentVideoState(video) }).then(response => {
        if (response && typeof response === 'object' && 'sessionId' in response) {
          currentSessionId = (response as { sessionId: string }).sessionId;
        }
      });
      sendDiagnostic('video_play_sent');
    }

    function attachVideoEvents(video: HTMLVideoElement): void {
      if (video.hasAttribute('data-jp343-tracked')) return;
      video.setAttribute('data-jp343-tracked', 'true');

      video.addEventListener('play', () => {
        if (pauseDebounceTimer) { clearTimeout(pauseDebounceTimer); pauseDebounceTimer = null; }
        lastVideoTime = video.currentTime;
        flushDelta();
        accumulatedDeltaMs = 0;
        log('[JP343] Nihongo no Jikan play:', getTitle());
        sendVideoPlay(video);
      });

      video.addEventListener('playing', () => {
        if (pauseDebounceTimer) { clearTimeout(pauseDebounceTimer); pauseDebounceTimer = null; }
        lastVideoTime = video.currentTime;
        flushDelta();
        accumulatedDeltaMs = 0;
        sendVideoPlay(video);
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
        if (tracking) sendMessage('VIDEO_ENDED');
        tracking = false;
      });

      video.addEventListener('waiting', () => { flushDelta(); });

      video.addEventListener('timeupdate', () => {
        if (video.paused || video.ended || !tracking) return;
        const ct = video.currentTime;
        const d = ct - lastVideoTime;
        lastVideoTime = ct;
        if (d > 0 && d <= 10) {
          const realDelta = d / (video.playbackRate || 1);
          accumulatedDeltaMs += realDelta * 1000;
          if (accumulatedDeltaMs >= 10_000) flushDelta();
        }
      });

      intervalIds.push(setInterval(() => {
        if (!tracking || video.paused || video.ended) return;
        sendMessage('VIDEO_STATE_UPDATE', { state: getCurrentVideoState(video) });
      }, 30000));

      log('[JP343] Nihongo no Jikan: Events bound');
      sendDiagnostic('player_found');
    }

    function pickUpVideo(): void {
      const video = document.querySelector('video');
      if (!video) return;
      if (video !== currentVideoElement) {
        currentVideoElement = video;
        attachVideoEvents(video);
      }
      if (!video.paused && !video.ended && !tracking) {
        lastVideoTime = video.currentTime;
        sendVideoPlay(video);
      }
    }

    const observer = new MutationObserver(() => {
      if (document.querySelector('video')) {
        observer.disconnect();
        pickUpVideo();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    observers.push(observer);

    pickUpVideo();
    setTimeout(pickUpVideo, 1500);
    setTimeout(pickUpVideo, 4000);

    browser.runtime.onMessage.addListener((message) => {
      if (message?.type === 'GET_CONTENT_TIME') {
        if (!currentSessionId) return undefined;
        return Promise.resolve({ unflushedMs: Math.round(accumulatedDeltaMs), sessionId: currentSessionId });
      }
      if (message?.type === 'PAUSE_VIDEO' && currentVideoElement) currentVideoElement.pause();
      if (message?.type === 'RESUME_VIDEO' && currentVideoElement) currentVideoElement.play();
      if (message?.type === 'TAB_ACTIVATED') pickUpVideo();
      return undefined;
    });
  }
});
