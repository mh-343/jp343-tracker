// JP343 Extension - YouTube Content Script

import type { VideoState } from '../../types';

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',

  main() {
    console.log('[JP343] YouTube Content Script geladen');

    let currentVideoElement: HTMLVideoElement | null = null;
    let lastVideoUrl: string | null = null;
    let isCurrentlyAd = false;
    let adCheckInterval: ReturnType<typeof setInterval> | null = null;
    let stateUpdateInterval: ReturnType<typeof setInterval> | null = null;
    let extensionContextValid = true;

    function isExtensionContextValid(): boolean {
      try {
        return extensionContextValid && !!browser.runtime?.id;
      } catch {
        return false;
      }
    }

    function invalidateExtensionContext(): void {
      if (extensionContextValid) {
        console.log('[JP343] Extension Context ungueltig - stoppe Tracking');
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

    // YouTube Video Element finden
    function findVideoElement(): HTMLVideoElement | null {
      const video = document.querySelector('video.html5-main-video') as HTMLVideoElement;
      return video || document.querySelector('video');
    }

    // Video-ID aus URL extrahieren
    function getVideoId(): string | null {
      const url = new URL(window.location.href);
      return url.searchParams.get('v');
    }

    // Video-Titel extrahieren
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
      // Entferne " - YouTube" am Ende
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

    // Channel-Informationen extrahieren
    function getChannelInfo(): { id: string | null; name: string | null; url: string | null } {
      let channelId: string | null = null;
      let channelName: string | null = null;
      let channelUrl: string | null = null;

      const channelNameSelectors = [
        // Neue YouTube Layouts
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

      // Erst Channel-Name finden
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

      // Channel-ID aus URL extrahieren
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
          // Ignorieren falls Parse fehlschlaegt
        }
      }

      return { id: channelId, name: channelName, url: channelUrl };
    }

    function isAdPlaying(): boolean {
      const adIndicators = [
        '.ytp-ad-player-overlay',
        '.ytp-ad-player-overlay-instream-info',
        '.ytp-ad-text',
        '.ytp-ad-skip-button',
        '.ytp-ad-skip-button-container',
        '.ad-showing',
        '.ytp-ad-preview-container',
        '[class*="ad-interrupting"]'
      ];

      for (const selector of adIndicators) {
        if (document.querySelector(selector)) {
          return true;
        }
      }

      const player = document.querySelector('#movie_player');
      if (player?.classList.contains('ad-showing')) {
        return true;
      }

      return false;
    }

    // Aktuellen Video-State zusammenstellen
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

    // Message an Background senden
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
        // "Extension context invalidated" abfangen
        if (error instanceof Error && error.message.includes('Extension context invalidated')) {
          invalidateExtensionContext();
          return;
        }
        console.log('[JP343] Message error:', error);
      }
    }

    // Video Events binden
    function attachVideoEvents(video: HTMLVideoElement): void {
      if (video.hasAttribute('data-jp343-tracked')) {
        return;
      }
      video.setAttribute('data-jp343-tracked', 'true');

      video.addEventListener('play', () => {
        if (!isExtensionContextValid()) return;
        const state = getCurrentVideoState();
        if (state && !state.isAd) {
          sendMessage('VIDEO_PLAY', { state });
        }
      });

      video.addEventListener('pause', () => {
        if (!isExtensionContextValid()) return;
        sendMessage('VIDEO_PAUSE');
      });

      video.addEventListener('ended', () => {
        if (!isExtensionContextValid()) return;
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
      }

      console.log('[JP343] Video Events gebunden');

      setTimeout(() => {
        if (!isExtensionContextValid()) return;
        if (!video.paused && !video.ended) {
          const state = getCurrentVideoState();
          if (state && !state.isAd) {
            console.log('[JP343] Video laeuft bereits - starte Tracking');
            sendMessage('VIDEO_PLAY', { state });
          }
        }
      }, 500);
    }

    // Ad-Status ueberwachen
    function startAdMonitoring(): void {
      if (adCheckInterval) return;

      adCheckInterval = setInterval(() => {
        if (!isExtensionContextValid()) {
          invalidateExtensionContext();
          return;
        }

        const isAd = isAdPlaying();

        if (isAd && !isCurrentlyAd) {
          isCurrentlyAd = true;
          sendMessage('AD_START');
        } else if (!isAd && isCurrentlyAd) {
          isCurrentlyAd = false;
          sendMessage('AD_END');
        }
      }, 500);
    }

    function handleUrlChange(): void {
      if (!isExtensionContextValid()) return;

      const currentUrl = window.location.href;

      if (currentUrl !== lastVideoUrl) {
        if (lastVideoUrl && lastVideoUrl.includes('/watch')) {
          console.log('[JP343] URL-Wechsel - beende vorherige Session');
          sendMessage('VIDEO_ENDED');
        }

        lastVideoUrl = currentUrl;

        setTimeout(() => {
          if (!isExtensionContextValid()) return;
          const video = findVideoElement();
          if (video && video !== currentVideoElement) {
            currentVideoElement = video;
            attachVideoEvents(video);
          }
        }, 1000);
      }
    }

    const observer = new MutationObserver(() => {
      if (!isExtensionContextValid()) {
        observer.disconnect();
        return;
      }

      handleUrlChange();

      if (!currentVideoElement) {
        const video = findVideoElement();
        if (video) {
          currentVideoElement = video;
          attachVideoEvents(video);
          startAdMonitoring();
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    function tryInitialVideoAttach(attempts = 0): void {
      if (!isExtensionContextValid()) return;

      const video = findVideoElement();
      if (video) {
        currentVideoElement = video;
        attachVideoEvents(video);
        startAdMonitoring();
        console.log('[JP343] Video gefunden nach', attempts, 'Versuchen');
      } else if (attempts < 10) {
        // Nochmal versuchen (max 10x = 5 Sekunden)
        setTimeout(() => tryInitialVideoAttach(attempts + 1), 500);
      }
    }

    // Nur auf Watch-Seiten initial suchen
    if (window.location.pathname.includes('/watch')) {
      tryInitialVideoAttach();
    }

    // URL-Aenderungen via History API
    const originalPushState = history.pushState;
    history.pushState = function(...args) {
      originalPushState.apply(history, args);
      setTimeout(handleUrlChange, 100);
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function(...args) {
      originalReplaceState.apply(history, args);
      setTimeout(handleUrlChange, 100);
    };

    window.addEventListener('popstate', () => {
      setTimeout(handleUrlChange, 100);
    });

    lastVideoUrl = window.location.href;
  }
});
