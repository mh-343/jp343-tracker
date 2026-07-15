import type { VideoState, Platform } from '../../types';
import { showUpdateNotification } from '../../lib/update-notification';
import { claimContentScript } from '../../lib/content-guard';
import { resolveCustomSiteMeta } from './custom-sites-meta';

export default defineContentScript({
  matches: ['https://*/*'],
  registration: 'runtime',
  runAt: 'document_idle',
  main() {
    if (!claimContentScript('custom-sites')) return;
    const PLATFORM: Platform = 'generic';

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
    let lastVideoTime = 0;
    let accumulatedDeltaMs = 0;
    let pauseDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    window.addEventListener('pagehide', () => {
      if (currentSessionId) {
        flushDelta();
        sendMessage('VIDEO_ENDED');
      }
      cleanup();
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
      sendMessage('TIME_DELTA', { deltaMs: Math.round(ms), sessionId: currentSessionId });
    }

    function collectVideos(): HTMLVideoElement[] {
      const out: HTMLVideoElement[] = [];
      const scan = (root: Document | ShadowRoot): void => {
        try { root.querySelectorAll('video').forEach(v => out.push(v)); } catch { /* ignore */ }
        try { root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) scan(el.shadowRoot); }); } catch { /* ignore */ }
      };
      scan(document);
      for (const frame of Array.from(document.querySelectorAll('iframe'))) {
        try {
          if (frame.contentDocument) scan(frame.contentDocument);
        } catch { /* cross-origin */ }
      }
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
      sendMessage('VIDEO_PLAY', { state: buildState(video) }).then(response => {
        if (response && typeof response === 'object' && 'sessionId' in response) {
          currentSessionId = (response as { sessionId: string }).sessionId;
        }
      });
      log('[JP343] custom-sites: play', currentTitle);
    }

    function bindVideo(video: HTMLVideoElement): void {
      if (video.hasAttribute('data-jp343-tracked')) return;
      video.setAttribute('data-jp343-tracked', 'true');

      video.addEventListener('play', () => {
        if (pauseDebounceTimer) { clearTimeout(pauseDebounceTimer); pauseDebounceTimer = null; }
        startTracking(video);
      });
      video.addEventListener('playing', () => {
        if (pauseDebounceTimer) { clearTimeout(pauseDebounceTimer); pauseDebounceTimer = null; }
        lastVideoTime = video.currentTime;
      });
      video.addEventListener('pause', () => {
        flushDelta();
        if (pauseDebounceTimer) clearTimeout(pauseDebounceTimer);
        pauseDebounceTimer = setTimeout(() => {
          pauseDebounceTimer = null;
          if (video.paused && !video.ended) { log('[JP343] custom-sites: pause'); sendMessage('VIDEO_PAUSE'); }
        }, 300);
      });
      video.addEventListener('ended', () => {
        flushDelta();
        log('[JP343] custom-sites: ended');
        sendMessage('VIDEO_ENDED');
        currentSessionId = null;
      });
      video.addEventListener('waiting', () => { flushDelta(); });
      video.addEventListener('timeupdate', () => {
        if (video.paused || video.ended) return;
        const ct = video.currentTime;
        const delta = ct - lastVideoTime;
        lastVideoTime = ct;
        if (delta > 0 && delta <= 10) {
          accumulatedDeltaMs += (delta / (video.playbackRate || 1)) * 1000;
          if (accumulatedDeltaMs >= 10_000) flushDelta();
        }
      });
    }

    function syncVideo(): void {
      const vids = collectVideos();

      if (boundVideo && vids.includes(boundVideo)) {
        const meta = resolveCustomSiteMeta(location);
        if (meta.videoId !== currentVideoId) {
          if (currentSessionId) { flushDelta(); sendMessage('VIDEO_ENDED'); currentSessionId = null; }
          currentTitle = meta.title;
          currentVideoId = meta.videoId;
          currentUrl = meta.url;
          if (!boundVideo.paused && !boundVideo.ended) startTracking(boundVideo);
        }
        return;
      }

      if (boundVideo && currentSessionId) {
        flushDelta();
        sendMessage('VIDEO_ENDED');
        currentSessionId = null;
      }
      boundVideo = null;

      const video = pickVideo(vids);
      if (!video) return;
      const meta = resolveCustomSiteMeta(location);
      boundVideo = video;
      currentTitle = meta.title;
      currentVideoId = meta.videoId;
      currentUrl = meta.url;
      bindVideo(video);
      if (!video.paused && !video.ended) startTracking(video);
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
      if (message?.type === 'PAUSE_VIDEO' && boundVideo) boundVideo.pause();
      if (message?.type === 'RESUME_VIDEO' && boundVideo) boundVideo.play();
      if (message?.type === 'TAB_ACTIVATED') syncVideo();
      return undefined;
    });
  }
});
