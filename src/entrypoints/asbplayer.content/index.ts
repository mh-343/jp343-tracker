import type { VideoState, Platform } from '../../types';
import { showUpdateNotification } from '../../lib/update-notification';
import { claimContentScript } from '../../lib/content-guard';

export default defineContentScript({
  matches: ['*://app.asbplayer.dev/*'],
  runAt: 'document_idle',
  main() {
    if (!claimContentScript('asbplayer')) return;
    const PLATFORM: Platform = 'asbplayer';
    const FALLBACK_TITLE = 'Local video file';
    const VIDEO_EXTENSION = /\.(mp4|mkv|webm|avi|mov|m4v|ogv|ts)$/i;

    const observers: MutationObserver[] = [];
    const intervalIds: ReturnType<typeof setInterval>[] = [];
    function cleanup(): void {
      observers.forEach(o => o.disconnect());
      intervalIds.forEach(clearInterval);
      observers.length = 0;
      intervalIds.length = 0;
      window.removeEventListener('drop', onDrop, true);
      document.removeEventListener('change', onFileInput, true);
      if (thumbnailTimer) clearTimeout(thumbnailTimer);
    }

    const DEBUG_MODE = import.meta.env.DEV;
    const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};

    let boundVideo: HTMLVideoElement | null = null;
    let currentTitle = FALLBACK_TITLE;
    let currentVideoId = '';
    let currentUrl = location.origin + '/';
    let currentSessionId: string | null = null;
    let lastVideoTime = 0;
    let accumulatedDeltaMs = 0;
    let pauseDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let latestFileName: string | null = null;
    let currentThumbnail: string | null = null;
    let thumbnailCaptured = false;
    let thumbnailTimer: ReturnType<typeof setTimeout> | null = null;

    function hashString(input: string): string {
      let hash = 0;
      for (let i = 0; i < input.length; i++) {
        hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0;
      }
      return (hash >>> 0).toString(36);
    }

    function pickVideoName(files: FileList): string | null {
      for (const file of Array.from(files)) {
        if (file.type.startsWith('video/') || VIDEO_EXTENSION.test(file.name)) {
          return file.name.replace(/\.[^.]+$/, '');
        }
      }
      return null;
    }

    function onDrop(event: DragEvent): void {
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const name = pickVideoName(files);
      if (name) {
        latestFileName = name;
        log('[JP343] asbplayer: file dropped', name);
      }
    }

    function onFileInput(event: Event): void {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type === 'file' && target.files) {
        const name = pickVideoName(target.files);
        if (name) latestFileName = name;
      }
    }

    window.addEventListener('drop', onDrop, true);
    document.addEventListener('change', onFileInput, true);
    window.addEventListener('pagehide', () => {
      if (currentSessionId) {
        flushDelta();
        sendMessage('VIDEO_ENDED');
      }
      cleanup();
    });

    const isIncognito = browser.extension?.inIncognitoContext ?? false;
    function sendDiagnostic(code: string): void {
      if (isIncognito) return;
      try {
        browser.runtime.sendMessage({ type: 'DIAGNOSTIC_EVENT', code, platform: PLATFORM }).catch(() => {});
      } catch { /* best-effort */ }
    }

    async function sendMessage(type: string, data?: Record<string, unknown>): Promise<unknown> {
      try {
        return await browser.runtime.sendMessage({ type, platform: PLATFORM, ...data });
      } catch (error) {
        if (error instanceof Error && error.message.includes('Extension context invalidated')) {
          showUpdateNotification();
          return;
        }
        log('[JP343] asbplayer: Message error:', error);
        return undefined;
      }
    }

    function flushDelta(): void {
      if (accumulatedDeltaMs <= 0 || !currentSessionId) return;
      const ms = accumulatedDeltaMs;
      accumulatedDeltaMs = 0;
      sendMessage('TIME_DELTA', { deltaMs: Math.round(ms), sessionId: currentSessionId });
    }

    function locateVideoElement(): HTMLVideoElement | null {
      const direct = document.querySelector('video');
      if (direct) return direct;
      for (const frame of Array.from(document.querySelectorAll('iframe'))) {
        try {
          const inner = frame.contentDocument?.querySelector('video');
          if (inner) return inner;
        } catch { /* cross-origin frame, skip */ }
      }
      return null;
    }

    function ensureIframeReloadListeners(): void {
      for (const frame of Array.from(document.querySelectorAll('iframe'))) {
        if (frame.hasAttribute('data-jp343-asb')) continue;
        frame.setAttribute('data-jp343-asb', 'true');
        frame.addEventListener('load', syncVideo);
      }
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
        thumbnailUrl: currentThumbnail,
        videoId: currentVideoId,
        channelId: null,
        channelName: null,
        channelUrl: null
      };
    }

    function resolveSessionMeta(): void {
      currentTitle = latestFileName ?? FALLBACK_TITLE;
      latestFileName = null;
      currentVideoId = hashString(currentTitle);
      currentUrl = location.origin + '/#asb-' + currentVideoId;
      currentThumbnail = null;
      thumbnailCaptured = false;
    }

    function captureThumbnail(video: HTMLVideoElement): void {
      if (thumbnailCaptured || video !== boundVideo) return;
      if (video.readyState < 2 || !video.videoWidth) return;
      try {
        const width = 240;
        const height = Math.round((video.videoHeight / video.videoWidth) * width) || 135;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, width, height);
        currentThumbnail = canvas.toDataURL('image/jpeg', 0.6);
        thumbnailCaptured = true;
        if (!video.paused && !video.ended && currentSessionId) {
          sendMessage('VIDEO_PLAY', { state: buildState(video) });
        }
      } catch { /* tainted source or frame not ready */ }
    }

    function scheduleThumbnail(video: HTMLVideoElement): void {
      if (thumbnailTimer) clearTimeout(thumbnailTimer);
      thumbnailTimer = setTimeout(() => {
        thumbnailTimer = null;
        captureThumbnail(video);
      }, 2500);
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
      sendDiagnostic('video_play_sent');
      sendDiagnostic(currentTitle !== FALLBACK_TITLE ? 'metadata_found' : 'metadata_missing');
      log('[JP343] asbplayer: play', currentTitle);
    }

    function bindVideo(video: HTMLVideoElement): void {
      if (video.hasAttribute('data-jp343-tracked')) return;
      video.setAttribute('data-jp343-tracked', 'true');

      video.addEventListener('play', () => {
        if (pauseDebounceTimer) { clearTimeout(pauseDebounceTimer); pauseDebounceTimer = null; sendDiagnostic('pause_debounced'); }
        startTracking(video);
      });

      video.addEventListener('playing', () => {
        if (pauseDebounceTimer) { clearTimeout(pauseDebounceTimer); pauseDebounceTimer = null; sendDiagnostic('pause_debounced'); }
        lastVideoTime = video.currentTime;
      });

      video.addEventListener('pause', () => {
        flushDelta();
        if (pauseDebounceTimer) clearTimeout(pauseDebounceTimer);
        pauseDebounceTimer = setTimeout(() => {
          pauseDebounceTimer = null;
          if (video.paused && !video.ended) sendMessage('VIDEO_PAUSE');
        }, 300);
      });

      video.addEventListener('ended', () => {
        flushDelta();
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

      sendDiagnostic('player_found');
      log('[JP343] asbplayer: events bound');
    }

    function syncVideo(): void {
      ensureIframeReloadListeners();
      const video = locateVideoElement();
      if (video && video !== boundVideo) {
        if (boundVideo) {
          flushDelta();
          sendMessage('VIDEO_ENDED');
          currentSessionId = null;
        }
        boundVideo = video;
        resolveSessionMeta();
        bindVideo(video);
        scheduleThumbnail(video);
        if (!video.paused && !video.ended) startTracking(video);
      } else if (!video && boundVideo) {
        flushDelta();
        sendMessage('VIDEO_ENDED');
        currentSessionId = null;
        boundVideo = null;
      }
    }

    sendDiagnostic('content_script_loaded');

    const observer = new MutationObserver(() => syncVideo());
    observer.observe(document.body, { childList: true, subtree: true });
    observers.push(observer);

    intervalIds.push(setInterval(syncVideo, 1000));
    syncVideo();

    setTimeout(() => { if (!boundVideo) sendDiagnostic('player_missing'); }, 15000);

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
