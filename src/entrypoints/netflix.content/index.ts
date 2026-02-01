// JP343 Extension - Netflix Content Script
// Erkennt Video-Playback auf Netflix

import type { VideoState } from '../../types';

export default defineContentScript({
  matches: ['*://*.netflix.com/*'],
  runAt: 'document_idle',

  main() {
    console.log('[JP343] Netflix Content Script geladen');

    let currentVideoElement: HTMLVideoElement | null = null;
    let lastTitle: string = '';

    function findVideoElement(): HTMLVideoElement | null {
      return document.querySelector('video') as HTMLVideoElement;
    }

    function getVideoTitle(): string {
      const selectors = [
        '[data-uia="video-title"]',
        '.video-title',
        '.title-wrapper .title',
        '.ellipsize-text',
        '.player-controls-content .ellipsize-text'
      ];

      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element?.textContent?.trim()) {
          return element.textContent.trim();
        }
      }

      const docTitle = document.title;
      if (docTitle && !docTitle.includes('Netflix')) {
        return docTitle.split('|')[0].trim();
      }

      return 'Netflix Content';
    }

    function getVideoId(): string | null {
      const match = window.location.pathname.match(/\/watch\/(\d+)/);
      return match ? match[1] : null;
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
        title: getVideoTitle(),
        url: window.location.href,
        platform: 'netflix',
        isAd: false,
        thumbnailUrl: null,
        videoId: videoId,
        // Netflix hat keine Channel-Informationen
        channelId: null,
        channelName: null,
        channelUrl: null
      };
    }

    async function sendMessage(type: string, data?: Record<string, unknown>): Promise<void> {
      try {
        await browser.runtime.sendMessage({
          type,
          platform: 'netflix',
          ...data
        });
      } catch (error) {
        console.log('[JP343] Message error:', error);
      }
    }

    function attachVideoEvents(video: HTMLVideoElement): void {
      if (video.hasAttribute('data-jp343-tracked')) {
        return;
      }
      video.setAttribute('data-jp343-tracked', 'true');

      video.addEventListener('play', () => {
        const state = getCurrentVideoState();
        if (state) {
          sendMessage('VIDEO_PLAY', { state });
        }
      });

      video.addEventListener('pause', () => {
        sendMessage('VIDEO_PAUSE');
      });

      video.addEventListener('ended', () => {
        sendMessage('VIDEO_ENDED');
      });

      setInterval(() => {
        const state = getCurrentVideoState();
        if (state && state.isPlaying) {
          if (state.title !== lastTitle) {
            lastTitle = state.title;
            sendMessage('VIDEO_ENDED');
            setTimeout(() => {
              const newState = getCurrentVideoState();
              if (newState && newState.isPlaying) {
                sendMessage('VIDEO_PLAY', { state: newState });
              }
            }, 500);
          } else {
            sendMessage('VIDEO_STATE_UPDATE', { state });
          }
        }
      }, 30000);

      console.log('[JP343] Netflix Video Events gebunden');
    }

    const observer = new MutationObserver(() => {
      const video = findVideoElement();

      if (video && video !== currentVideoElement) {
        currentVideoElement = video;
        attachVideoEvents(video);
        lastTitle = getVideoTitle();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    const initialVideo = findVideoElement();
    if (initialVideo) {
      currentVideoElement = initialVideo;
      attachVideoEvents(initialVideo);
      lastTitle = getVideoTitle();
    }

    let lastUrl = window.location.href;
    setInterval(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;

        setTimeout(() => {
          const video = findVideoElement();
          if (video && video !== currentVideoElement) {
            currentVideoElement = video;
            attachVideoEvents(video);
            lastTitle = getVideoTitle();
          }
        }, 1000);
      }
    }, 1000);
  }
});
