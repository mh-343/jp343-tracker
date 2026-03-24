// =============================================================================
// JP343 Extension - Disney+ Content Script
// =============================================================================

import type { VideoState } from '../../types';

export default defineContentScript({
  matches: ['*://*.disneyplus.com/*'],
  runAt: 'document_idle',

  main() {
    let currentVideoElement: HTMLVideoElement | null = null;
    let lastTitle: string = '';
    let lastVideoId: string | null = null;
    let isCurrentlyInAd: boolean = false;

    // Cleanup-Registry
    const observers: MutationObserver[] = [];
    const intervalIds: ReturnType<typeof setInterval>[] = [];
    function cleanup(): void {
      observers.forEach(o => o.disconnect());
      intervalIds.forEach(clearInterval);
      observers.length = 0;
      intervalIds.length = 0;
    }

    // Bei Seitenverlassen: Session beenden + Cleanup
    window.addEventListener('pagehide', () => {
      if (lastVideoId) {
        sendMessage('VIDEO_ENDED');
      }
      cleanup();
    });
    window.addEventListener('beforeunload', () => {
      if (lastVideoId) {
        sendMessage('VIDEO_ENDED');
      }
    });

    const DEBUG_MODE = false;
    const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};

    // =======================================================================
    // VIDEO ELEMENT + WATCH PAGE ERKENNUNG
    // =======================================================================

    function findVideoElement(): HTMLVideoElement | null {
      return (document.querySelector('video.hive-video') as HTMLVideoElement)
        || (document.querySelector('.btm-media-client video[src]') as HTMLVideoElement)
        || null;
    }

    function isWatchPage(): boolean {
      // Disney+ Player-URLs: /play/<UUID> oder /de-de/play/<UUID>
      return window.location.pathname.includes('/play/');
    }

    function getVideoId(): string | null {
      // UUID aus URL: /play/<UUID> oder /de-de/play/<UUID>
      const match = window.location.pathname.match(/\/play\/([a-f0-9-]{36})/i);
      return match ? match[1] : null;
    }

    // =======================================================================
    // TITEL-EXTRAKTION
    // =======================================================================

    function getTitle(): string {
      // document.title: "Bleach | Disney+" -> "Bleach"
      const docTitle = document.title;
      if (docTitle) {
        const cleaned = docTitle
          .replace(/\s*\|\s*Disney\+.*$/i, '')
          .replace(/\s*[-–]\s*Disney\+.*$/i, '')
          .trim();
        if (cleaned && cleaned.length > 1) {
          return cleaned;
        }
      }
      return 'Disney+ Content';
    }

    function getThumbnail(): string | null {
      // 1. og:image Meta-Tag (wenn vorhanden)
      const ogImage = document.querySelector('meta[property="og:image"]') as HTMLMetaElement;
      if (ogImage?.content && ogImage.content.startsWith('https://')) {
        return ogImage.content;
      }
      // TODO: Disney+ Thumbnail-Erfassung
      return null;
    }

    // =======================================================================
    // WERBUNG ERKENNUNG
    // =======================================================================

    function hasAdCountdown(): boolean {
      const badge = document.querySelector('ad-badge-overlay');
      if (!badge?.shadowRoot) return false;
      const text = badge.shadowRoot.textContent?.trim() || '';
      return /\d+:\d{2}/.test(text);
    }

    function isAdPlaying(): boolean {
      if (!isWatchPage()) return false;
      return hasAdCountdown();
    }

    // Auto-Tracking starten wenn Content nach Werbung laeuft
    function startTrackingIfContentPlaying(): void {
      if (isCurrentlyInAd) return;
      const video = findVideoElement();
      const videoId = getVideoId();
      if (video && !video.paused && !video.ended && videoId) {
        if (!lastVideoId) {
          lastVideoId = videoId;
          lastTitle = getTitle();
          const state = getCurrentVideoState();
          if (state && !state.isAd) {
            log('[JP343] Disney+: Auto-Tracking nach Werbung:', state.title);
            sendMessage('VIDEO_PLAY', { state });
          }
        }
      }
    }

    function handleAdStateChange(): void {
      const adPlaying = isAdPlaying();

      if (adPlaying && !isCurrentlyInAd) {
        isCurrentlyInAd = true;

        log('[JP343] Disney+: Werbung beginnt');
        sendMessage('AD_START');
      } else if (!adPlaying && isCurrentlyInAd) {
        isCurrentlyInAd = false;

        log('[JP343] Disney+: Werbung beendet');
        sendMessage('AD_END');

        // Nach Ad-Ende: kurz warten und Content-Tracking starten
        setTimeout(() => {
          startTrackingIfContentPlaying();
        }, 1500);
      }
    }

    // Ad-Status alle 500ms pruefen
    intervalIds.push(setInterval(handleAdStateChange, 500));

    // =======================================================================
    // VIDEO STATE + MESSAGING
    // =======================================================================

    function getCurrentVideoState(): VideoState | null {
      const video = findVideoElement();
      if (!video) return null;

      const videoId = getVideoId();
      if (!videoId) return null;

      const title = getTitle();

      return {
        isPlaying: !video.paused && !video.ended,
        currentTime: video.currentTime,
        duration: video.duration || 0,
        title: title,
        url: window.location.href,
        platform: 'disneyplus',
        isAd: isCurrentlyInAd || isAdPlaying(),
        thumbnailUrl: getThumbnail(),
        videoId: videoId,
        // Titel als Channel fuer Block-Funktion (Filme + Serien)
        channelId: (title !== 'Disney+ Content') ? 'disneyplus:' + title : null,
        channelName: (title !== 'Disney+ Content') ? title : null,
        channelUrl: null
      };
    }

    async function sendMessage(type: string, data?: Record<string, unknown>): Promise<void> {
      try {
        await browser.runtime.sendMessage({
          type,
          platform: 'disneyplus',
          ...data
        });
      } catch (error) {
        log('[JP343] Disney+: Message error:', error);
      }
    }

    // =======================================================================
    // VIDEO EVENT BINDING
    // =======================================================================

    function attachVideoEvents(video: HTMLVideoElement): void {
      if (video.hasAttribute('data-jp343-tracked')) return;
      video.setAttribute('data-jp343-tracked', 'true');

      video.addEventListener('play', () => {
        if (!isWatchPage()) {
          log('[JP343] Disney+: Play auf Nicht-Watch-Seite ignoriert');
          return;
        }



        if (isAdPlaying() || isCurrentlyInAd) {

          log('[JP343] Disney+: Play waehrend Werbung ignoriert');
          if (!isCurrentlyInAd) {
            isCurrentlyInAd = true;
            sendMessage('AD_START');
          }
          return;
        }

        const videoId = getVideoId();
        if (videoId && lastVideoId && videoId !== lastVideoId) {
          // Video-Wechsel
          sendMessage('VIDEO_ENDED');
        }

        const state = getCurrentVideoState();
        if (state) {
          lastVideoId = videoId;
          lastTitle = state.title;
          log('[JP343] Disney+ Play:', state.title);
          sendMessage('VIDEO_PLAY', { state });
        }
      });

      video.addEventListener('pause', () => {

        if (isCurrentlyInAd) return;
        sendMessage('VIDEO_PAUSE');
      });

      video.addEventListener('ended', () => {

        if (isCurrentlyInAd) {
          log('[JP343] Disney+: ended waehrend Werbung ignoriert');
          return;
        }
        sendMessage('VIDEO_ENDED');
        lastVideoId = null;
      });

      // Periodische Updates (alle 30 Sekunden)
      const updateInterval = setInterval(() => {
        if (isCurrentlyInAd || !isWatchPage()) return;

        const state = getCurrentVideoState();
        if (state && state.isPlaying) {
          const currentVideoId = getVideoId();
          if (currentVideoId && lastVideoId && currentVideoId !== lastVideoId) {
            log('[JP343] Disney+: Video-Wechsel:', lastVideoId, '->', currentVideoId);
            sendMessage('VIDEO_ENDED');
            lastVideoId = currentVideoId;
            lastTitle = state.title;
            setTimeout(() => {
              const newState = getCurrentVideoState();
              if (newState && newState.isPlaying && !isCurrentlyInAd) {
                sendMessage('VIDEO_PLAY', { state: newState });
              }
            }, 500);
          } else {
            if (state.title !== lastTitle) lastTitle = state.title;
            sendMessage('VIDEO_STATE_UPDATE', { state });
          }
        }
      }, 30000);
      intervalIds.push(updateInterval);

      // Schnelle Titel-Updates
      let quickCount = 0;
      const quickUpdate = setInterval(() => {
        quickCount++;
        if (isCurrentlyInAd || video.paused) return;
        const state = getCurrentVideoState();
        if (state && state.isPlaying && state.title !== lastTitle) {
          lastTitle = state.title;
          sendMessage('VIDEO_STATE_UPDATE', { state });
        }
        if (quickCount >= 6) clearInterval(quickUpdate);
      }, 5000);
      intervalIds.push(quickUpdate);

      log('[JP343] Disney+: Events gebunden');
    }

    // =======================================================================
    // OBSERVER + INIT
    // =======================================================================

    const observer = new MutationObserver(() => {
      if (!isWatchPage()) return;

      const video = findVideoElement();
      if (video && video !== currentVideoElement) {
        currentVideoElement = video;
        attachVideoEvents(video);
        const videoId = getVideoId();

        if (!video.paused && !video.ended && videoId) {
          if (isAdPlaying() || isCurrentlyInAd) {
            log('[JP343] Disney+: Neues Video waehrend Werbung');
            if (!isCurrentlyInAd) {
              isCurrentlyInAd = true;
              sendMessage('AD_START');
            }
          } else {
            log('[JP343] Disney+: Video laeuft bereits');
            lastVideoId = videoId;
            lastTitle = getTitle();
            const state = getCurrentVideoState();
            if (state) {
              sendMessage('VIDEO_PLAY', { state });
            }
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    observers.push(observer);

    // Initiales Video suchen
    if (isWatchPage()) {
      const initialVideo = findVideoElement();
      if (initialVideo) {
        currentVideoElement = initialVideo;
        attachVideoEvents(initialVideo);
        const videoId = getVideoId();

        if (!initialVideo.paused && !initialVideo.ended && videoId) {
          if (isAdPlaying()) {
            isCurrentlyInAd = true;
            sendMessage('AD_START');
          } else {
            lastVideoId = videoId;
            lastTitle = getTitle();
            const state = getCurrentVideoState();
            if (state) {
              log('[JP343] Disney+: Initiales Video laeuft');
              sendMessage('VIDEO_PLAY', { state });
            }
          }
        }
      }
    }

    // SPA Navigation (URL Polling)
    let lastUrl = window.location.href;
    intervalIds.push(setInterval(() => {
      if (window.location.href !== lastUrl) {
        const oldUrl = lastUrl;
        const newUrl = window.location.href;
        const wasOnWatch = oldUrl.includes('/play/');
        const isOnWatch = newUrl.includes('/play/');


        log('[JP343] Disney+: URL-Wechsel:', oldUrl, '->', newUrl);
        lastUrl = newUrl;

        // Weg von Watch-Seite
        if (wasOnWatch && !isOnWatch) {
          log('[JP343] Disney+: Watch-Seite verlassen');
          sendMessage('VIDEO_ENDED');
          lastVideoId = null;
          lastTitle = '';
          isCurrentlyInAd = false;

          return;
        }

        // Neues Video
        if (isOnWatch) {
          lastVideoId = null;
          lastTitle = '';
          isCurrentlyInAd = false;

          setTimeout(() => {
            const video = findVideoElement();
            if (video) {
              if (video !== currentVideoElement) {
                currentVideoElement = video;
                attachVideoEvents(video);
              }
              const videoId = getVideoId();
              if (!video.paused && !video.ended && videoId && !lastVideoId) {
                if (isAdPlaying()) {
                  isCurrentlyInAd = true;
                  sendMessage('AD_START');
                } else {
                  lastVideoId = videoId;
                  lastTitle = getTitle();
                  const state = getCurrentVideoState();
                  if (state) {
                    sendMessage('VIDEO_PLAY', { state });
                  }
                }
              }
            }
          }, 1000);
        }
      }
    }, 1000));

    // Title-Observer
    const titleElement = document.querySelector('title');
    if (titleElement) {
      const titleObserver = new MutationObserver(() => {
        if (!isWatchPage()) return;
        const newTitle = getTitle();
        if (newTitle !== 'Disney+ Content' && newTitle !== lastTitle && lastVideoId) {
          log('[JP343] Disney+: Neuer Titel:', newTitle);
          lastTitle = newTitle;
        }
      });
      titleObserver.observe(titleElement, { childList: true, characterData: true, subtree: true });
      observers.push(titleObserver);
    }

    // Fallback nach 3s
    setTimeout(() => {
      if (!isWatchPage()) return;
      const video = findVideoElement();
      const videoId = getVideoId();
      if (video && !video.paused && !video.ended && videoId && !isAdPlaying() && !isCurrentlyInAd && !lastVideoId) {
        log('[JP343] Disney+: Verzoegertes Tracking');
        lastVideoId = videoId;
        lastTitle = getTitle();
        const state = getCurrentVideoState();
        if (state) {
          sendMessage('VIDEO_PLAY', { state });
        }
      }
    }, 3000);

    // PAUSE/RESUME vom Popup
    browser.runtime.onMessage.addListener((message) => {
      if (message?.type === 'PAUSE_VIDEO' && currentVideoElement) {
        currentVideoElement.pause();
      }
      if (message?.type === 'RESUME_VIDEO' && currentVideoElement) {
        currentVideoElement.play();
      }
    });
  }
});
