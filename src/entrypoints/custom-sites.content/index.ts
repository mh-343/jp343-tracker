import type { VideoState, Platform } from '../../types';
import { showUpdateNotification } from '../../lib/update-notification';
import { claimContentScript } from '../../lib/content-guard';
import { sampleAttention } from '../../lib/attention';
import { resolveCustomSiteMeta, resolveMetaSource, isWatchableVideo } from './custom-sites-meta';
import type { CustomSiteMeta } from './custom-sites-meta';

export default defineContentScript({
  matches: ['https://*/*'],
  registration: 'runtime',
  runAt: 'document_idle',
  main() {
    // same-origin parents cover this frame
    if (window.self !== window.top) {
      let parentSameOrigin = false;
      try {
        parentSameOrigin = Boolean(window.parent.document);
      } catch { /* cross-origin parent */ }
      if (parentSameOrigin) return;
    }
    if (!claimContentScript('custom-sites')) return;
    const PLATFORM: Platform = 'generic';

    const isTopFrame = window.self === window.top;
    function currentMeta(): CustomSiteMeta {
      return resolveCustomSiteMeta(
        resolveMetaSource(location, isTopFrame, document.referrer)
      );
    }

    const observers: MutationObserver[] = [];
    const intervalIds: ReturnType<typeof setInterval>[] = [];
    function cleanup(): void {
      observers.forEach(o => o.disconnect());
      intervalIds.forEach(clearInterval);
      observers.length = 0;
      intervalIds.length = 0;
    }

    const DEBUG_MODE = import.meta.env.DEV;
    const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};

    let boundVideo: HTMLVideoElement | null = null;
    let currentTitle = '';
    let currentVideoId = '';
    let currentUrl = location.origin + '/';
    let currentSessionId: string | null = null;
    let pendingPlay = false;
    let playToken = 0;
    let boundSrc = '';
    let lastVideoTime = 0;
    let accumulatedDeltaMs = 0;
    let pauseDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    // rejected plays back off for 60s
    let nextPlayAttemptAt = 0;

    window.addEventListener('pagehide', () => {
      endSession();
      cleanup();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) flushDelta();
    });

    async function sendMessage(type: string, data?: Record<string, unknown>): Promise<unknown> {
      try {
        return await browser.runtime.sendMessage({ type, platform: PLATFORM, ...data });
      } catch (error) {
        if (error instanceof Error && error.message.includes('Extension context invalidated')) {
          showUpdateNotification();
          return;
        }
        log('[JP343] custom-sites: message error', error);
        return undefined;
      }
    }

    function flushDelta(): void {
      if (accumulatedDeltaMs <= 0 || !currentSessionId) return;
      const ms = accumulatedDeltaMs;
      accumulatedDeltaMs = 0;
      sendMessage('TIME_DELTA', { deltaMs: Math.round(ms), sessionId: currentSessionId, attention: sampleAttention() });
    }

    function collectVideos(): HTMLVideoElement[] {
      const out: HTMLVideoElement[] = [];
      const scan = (root: Document | ShadowRoot): void => {
        try { root.querySelectorAll('video').forEach(v => out.push(v)); } catch { /* ignore */ }
        try {
          root.querySelectorAll('iframe').forEach(frame => {
            try {
              if (frame.contentDocument) scan(frame.contentDocument);
            } catch { /* cross-origin */ }
          });
        } catch { /* ignore */ }
        try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) scan(el.shadowRoot); }); } catch { /* ignore */ }
      };
      scan(document);
      return out;
    }

    function pickVideo(vids: HTMLVideoElement[]): HTMLVideoElement | null {
      if (vids.length === 0) return null;
      return vids.reduce((best, v) => {
        const a = (v.videoWidth || 0) * (v.videoHeight || 0);
        const b = (best.videoWidth || 0) * (best.videoHeight || 0);
        return a > b ? v : best;
      }, vids[0]);
    }

    function buildState(video: HTMLVideoElement): VideoState {
      return {
        isPlaying: !video.paused && !video.ended,
        currentTime: video.currentTime,
        duration: video.duration || 0,
        title: currentTitle,
        url: currentUrl,
        platform: PLATFORM,
        isAd: false,
        thumbnailUrl: null,
        videoId: currentVideoId,
        channelId: null,
        channelName: null,
        channelUrl: null
      };
    }

    function startTracking(video: HTMLVideoElement): void {
      flushDelta();
      accumulatedDeltaMs = 0;
      lastVideoTime = video.currentTime;
      pendingPlay = true;
      const token = ++playToken;
      sendMessage('VIDEO_PLAY', { state: buildState(video) }).then(response => {
        if (token !== playToken) return;
        pendingPlay = false;
        if (response && typeof response === 'object' && 'sessionId' in response) {
          currentSessionId = (response as { sessionId: string }).sessionId;
        } else if (response && typeof response === 'object' && 'skipped' in response) {
          nextPlayAttemptAt = Date.now() + 60_000;
        }
      });
      log('[JP343] custom-sites: play', currentTitle);
    }

    function endSession(): void {
      if (!currentSessionId && !pendingPlay) return;
      flushDelta();
      const data: Record<string, unknown> = {};
      if (currentSessionId) data.sessionId = currentSessionId;
      if (currentVideoId) data.videoId = currentVideoId;
      sendMessage('VIDEO_ENDED', data);
      currentSessionId = null;
      pendingPlay = false;
      playToken++;
    }

    function bindVideo(video: HTMLVideoElement): void {
      if (video.hasAttribute('data-jp343-tracked')) return;
      video.setAttribute('data-jp343-tracked', 'true');

      video.addEventListener('play', () => {
        if (video !== boundVideo) return;
        if (pauseDebounceTimer) { clearTimeout(pauseDebounceTimer); pauseDebounceTimer = null; }
        if (!isWatchableVideo(video)) return;
        nextPlayAttemptAt = 0;
        if (video.readyState >= 3) startTracking(video);
      });
      video.addEventListener('playing', () => {
        if (video !== boundVideo) return;
        if (pauseDebounceTimer) { clearTimeout(pauseDebounceTimer); pauseDebounceTimer = null; }
        lastVideoTime = video.currentTime;
      });
      video.addEventListener('pause', () => {
        if (video !== boundVideo) return;
        flushDelta();
        if (pauseDebounceTimer) clearTimeout(pauseDebounceTimer);
        pauseDebounceTimer = setTimeout(() => {
          pauseDebounceTimer = null;
          if (!currentSessionId && !pendingPlay) return;
          if (video.paused && !video.ended) {
            log('[JP343] custom-sites: pause');
            const data: Record<string, unknown> = {};
            if (currentSessionId) data.sessionId = currentSessionId;
            sendMessage('VIDEO_PAUSE', data);
          }
        }, 300);
      });
      video.addEventListener('ended', () => {
        if (video !== boundVideo) return;
        log('[JP343] custom-sites: ended');
        endSession();
      });
      video.addEventListener('waiting', () => { if (video === boundVideo) flushDelta(); });
      video.addEventListener('timeupdate', () => {
        if (video !== boundVideo) return;
        if (video.paused || video.ended) return;
        const ct = video.currentTime;
        const delta = ct - lastVideoTime;
        lastVideoTime = ct;
        if (!currentSessionId && !pendingPlay) {
          if (delta > 0 && delta <= 10 && isWatchableVideo(video) && Date.now() >= nextPlayAttemptAt) {
            startTracking(video);
          }
          return;
        }
        if (delta < 0 && video.loop) { endSession(); return; }
        if (delta > 0 && delta <= 10) {
          accumulatedDeltaMs += (delta / (video.playbackRate || 1)) * 1000;
          if (accumulatedDeltaMs >= 10_000) flushDelta();
        }
      });
    }

    function syncVideo(): void {
      const vids = collectVideos();

      // early return only shields a live session; strong signals still end it
      if (boundVideo && vids.includes(boundVideo) && (currentSessionId || pendingPlay)) {
        const meta = currentMeta();
        const srcChanged = boundSrc !== '' && boundVideo.currentSrc !== '' && boundVideo.currentSrc !== boundSrc;
        if (meta.videoId !== currentVideoId || boundVideo.loop || srcChanged) {
          endSession();
          currentTitle = meta.title;
          currentVideoId = meta.videoId;
          currentUrl = meta.url;
          boundSrc = boundVideo.currentSrc;
          if (!boundVideo.paused && !boundVideo.ended && isWatchableVideo(boundVideo) && boundVideo.readyState >= 3) startTracking(boundVideo);
        }
        return;
      }

      endSession();
      boundVideo = null;

      const video = pickVideo(vids.filter(isWatchableVideo));
      if (!video) return;
      const meta = currentMeta();
      boundVideo = video;
      boundSrc = video.currentSrc;
      currentTitle = meta.title;
      currentVideoId = meta.videoId;
      currentUrl = meta.url;
      bindVideo(video);
      if (!video.paused && !video.ended && video.readyState >= 3 && Date.now() >= nextPlayAttemptAt) {
        startTracking(video);
      }
    }

    if (document.body) {
      const observer = new MutationObserver(() => {
        if (!browser.runtime?.id) { cleanup(); return; }
        syncVideo();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      observers.push(observer);
    }

    intervalIds.push(setInterval(() => {
      if (!browser.runtime?.id) { cleanup(); return; }
      syncVideo();
    }, 1000));
    syncVideo();

    browser.runtime.onMessage.addListener((message) => {
      if (message?.type === 'GET_CONTENT_TIME') {
        if (!currentSessionId) return undefined;
        return Promise.resolve({ unflushedMs: Math.round(accumulatedDeltaMs), sessionId: currentSessionId });
      }
      const ownsSession = Boolean(currentSessionId || pendingPlay);
      if (message?.type === 'PAUSE_VIDEO' && boundVideo && ownsSession) boundVideo.pause();
      if (message?.type === 'RESUME_VIDEO' && boundVideo && ownsSession) boundVideo.play();
      if (message?.type === 'TAB_ACTIVATED') { nextPlayAttemptAt = 0; syncVideo(); }
      return undefined;
    });
  }
});
