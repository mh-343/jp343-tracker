// JP343 Extension - Crunchyroll Content Script

import type { VideoState } from '../../types';
import { createDebugLogger, setupDebugCommands, DEBUG_MODE } from '../../lib/debug-logger';

interface CrunchyrollMetadata {
  title: string;
  episodeTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  thumbnailUrl: string | null;
  seriesName: string | null;
}

export default defineContentScript({
  matches: ['*://*.crunchyroll.com/*'],
  allFrames: true,
  runAt: 'document_idle',

  main() {
    const observers: MutationObserver[] = [];
    const intervalIds: ReturnType<typeof setInterval>[] = [];
    let stateUpdateIntervalId: ReturnType<typeof setInterval> | null = null;
    function cleanup(): void {
      observers.forEach(o => o.disconnect());
      intervalIds.forEach(clearInterval);
      if (stateUpdateIntervalId) { clearInterval(stateUpdateIntervalId); stateUpdateIntervalId = null; }
      observers.length = 0;
      intervalIds.length = 0;
    }
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

    const logger = createDebugLogger('crunchyroll');
    const { log, debugLog } = logger;
    log('[JP343] Crunchyroll Content Script loaded');

    const isIncognito = browser.extension?.inIncognitoContext ?? false;
    const isTopFrame = window === window.top;
    function sendDiagnostic(code: string): void {
      if (isIncognito || !isTopFrame) return;
      try {
        browser.runtime.sendMessage({ type: 'DIAGNOSTIC_EVENT', code, platform: 'crunchyroll' }).catch(() => {});
      } catch { /* best-effort */ }
    }
    function sendVideoPlay(state: VideoState): void {
      sendMessage('VIDEO_PLAY', { state });
      sendDiagnostic('video_play_sent');
      sendDiagnostic(state.title && state.title !== 'Crunchyroll Content' ? 'metadata_found' : 'metadata_missing');
    }

    sendDiagnostic('content_script_loaded');
    if (window.location.pathname.includes('/watch/')) {
      setTimeout(() => { if (!currentVideoElement) sendDiagnostic('player_missing'); }, 15000);
    }

    const isIframe = window !== window.top;
    log('[JP343] Context:', isIframe ? 'iframe' : 'main frame');

    function isAllowedOrigin(origin: string): boolean {
      try {
        const host = new URL(origin).hostname;
        return host === 'crunchyroll.com' || host.endsWith('.crunchyroll.com')
          || host === 'crunchyroll.co.jp' || host.endsWith('.crunchyroll.co.jp');
      } catch { return false; }
    }

    let currentVideoElement: HTMLVideoElement | null = null;
    let lastVideoId: string | null = null;
    let cachedMetadata: CrunchyrollMetadata | null = null;
    let bestKnownTitle: string = '';
    let isCurrentlyInAd: boolean = false;
    let pendingVideoId: string | null = null;

    if (DEBUG_MODE) { setupDebugCommands(logger, 'crunchyroll'); }

    function collectUIState(): Record<string, unknown> {
      const video = document.querySelector('video') as HTMLVideoElement | null;
      return {
        videoExists: !!video,
        videoPaused: video?.paused ?? null,
        videoEnded: video?.ended ?? null,
        videoDuration: video?.duration ?? null,
        videoCurrentTime: video?.currentTime ?? null,
        url: window.location.href,
        videoIdFromUrl: window.location.pathname.match(/\/watch\/([A-Z0-9]+)/i)?.[1] || null,
        documentTitle: document.title,
        adDataTestidElements: Array.from(document.querySelectorAll('[data-testid*="ad"]')).map(el => ({
          tag: el.tagName,
          dataTestid: el.getAttribute('data-testid'),
          classes: el.className,
          visible: (el as HTMLElement).offsetParent !== null
        })),
        videoPlayer: !!document.querySelector('.video-player'),
        videoPlayerIframe: !!document.querySelector('.video-player iframe'),
        bodyClasses: document.body.className,
        isCurrentlyInAd: isCurrentlyInAd,
        pendingVideoId: pendingVideoId,
        lastVideoId: lastVideoId,
        bestKnownTitle: bestKnownTitle
      };
    }

    if (DEBUG_MODE) {
      const domObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              const dataTestid = node.getAttribute?.('data-testid');
              const classes = node.className || '';
              const ariaLabel = node.getAttribute?.('aria-label');

              const isInteresting =
                dataTestid ||
                /ad|skip|overlay|countdown|player/i.test(classes) ||
                /ad|skip/i.test(ariaLabel || '');

              if (isInteresting) {
                debugLog('DOM_ADD', 'New element added', {
                  tag: node.tagName,
                  dataTestid: dataTestid,
                  classes: classes,
                  id: node.id,
                  ariaLabel: ariaLabel,
                  innerText: node.innerText?.slice(0, 100),
                  visible: node.offsetParent !== null,
                  rect: node.getBoundingClientRect()
                });
              }
            }
          });

          mutation.removedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              const dataTestid = node.getAttribute?.('data-testid');
              if (dataTestid && /ad|skip/i.test(dataTestid)) {
                debugLog('DOM_REMOVE', 'Element removed', {
                  tag: node.tagName,
                  dataTestid: dataTestid
                });
              }
            }
          });
        });
      });

      domObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
      observers.push(domObserver);

      debugLog('INIT', 'Debug Mutation Observer started');
    }

    function findVideoElement(): HTMLVideoElement | null {
      return document.querySelector('video') as HTMLVideoElement
        ?? document.querySelector('#player0') as HTMLVideoElement
        ?? null;
    }

    function isAdPlaying(): boolean {
      return false;
    }

    if (DEBUG_MODE) {
      intervalIds.push(setInterval(() => {
        const video = findVideoElement();
        if (video && !video.paused) {
          debugLog('PERIODIC', 'Periodic state check', collectUIState());
        }
      }, 5000));
    }

    function extractCrunchyrollMetadata(): CrunchyrollMetadata {
      const metadata: CrunchyrollMetadata = {
        title: 'Crunchyroll Content',
        episodeTitle: null,
        seasonNumber: null,
        episodeNumber: null,
        thumbnailUrl: null,
        seriesName: null
      };

      const isIframe = window !== window.top;
      let docTitle = document.title;

      if (isIframe) {
        if (cachedTitleFromParent) {
          docTitle = cachedTitleFromParent;
        } else {
          try {
            docTitle = window.parent.document.title;
          } catch (e) {
          }
        }
      }

      const isGenericTitle = !docTitle ||
        docTitle.toLowerCase() === 'crunchyroll' ||
        docTitle.toLowerCase().includes('crunchyroll home');

      if (!isGenericTitle) {
        const cleanTitle = docTitle
          .replace(/\s*[-–—|]\s*(?:\S+\s+){0,3}Crunchyroll\b.*$/i, '')
          .trim();

        if (cleanTitle && cleanTitle.length > 0 && cleanTitle.toLowerCase() !== 'crunchyroll') {
          const parsed = parseCrunchyrollTitle(cleanTitle);
          Object.assign(metadata, parsed);
          if (metadata.title !== 'Crunchyroll Content') {
            bestKnownTitle = metadata.title;
          }
        }
      }

      if (metadata.title === 'Crunchyroll Content' && bestKnownTitle) {
        metadata.title = bestKnownTitle;
      }

      if (metadata.title === 'Crunchyroll Content') {
        const ogTitle = document.querySelector('meta[property="og:title"]');
        if (ogTitle) {
          const content = ogTitle.getAttribute('content');
          if (content) {
            const parsed = parseCrunchyrollTitle(content);
            Object.assign(metadata, parsed);
          }
        }
      }

      if (!isIframe) {
        const domSeries = getSeriesInfo();
        if (domSeries.name) {
          metadata.seriesName = domSeries.name;
        } else {
          const structured = extractSeriesFromStructuredData();
          if (structured.name) metadata.seriesName = structured.name;
        }
      }

      if (isIframe && cachedSeriesNameFromParent) {
        metadata.seriesName = cachedSeriesNameFromParent;
        if (metadata.title === 'Crunchyroll Content') {
          metadata.title = cachedSeriesNameFromParent;
        }
      }

      if (isIframe && cachedEpisodeTextFromParent) {
        const epMatch = cachedEpisodeTextFromParent.match(/^E(\d+)\s*[-–]\s*(.+)$/i);
        if (epMatch) {
          const epNum = parseInt(epMatch[1], 10);
          const epTitle = epMatch[2].trim();
          metadata.episodeNumber = epNum;
          metadata.episodeTitle = epTitle;
          log('[JP343] Episode from DOM: E' + epNum + ' - ' + epTitle);
        }
      }

      if (isIframe && cachedThumbnailFromParent) {
        metadata.thumbnailUrl = cachedThumbnailFromParent;
      } else {
        metadata.thumbnailUrl = extractThumbnail();
      }

      return metadata;
    }

    function parseCrunchyrollTitle(rawTitle: string): Partial<CrunchyrollMetadata> {
      const result: Partial<CrunchyrollMetadata> = {
        title: rawTitle,
        seriesName: rawTitle
      };

      let match;

      match = rawTitle.match(/^(.+?)\s*[-–]\s*(?:Staffel|Season)\s*(\d+)(?::\s*[^(]+?)?\s*\(\d+[-–]\d+\)\s+(.+)$/i);
      if (match) {
        result.seriesName = match[1].trim();
        result.title = match[1].trim();
        result.seasonNumber = parseInt(match[2], 10);
        result.episodeTitle = match[3].trim();
        return result;
      }

      match = rawTitle.match(/^(.+?)\s*[-–]\s*(?:Staffel|Season)\s*(\d+)(?::\s*(.+))?$/i);
      if (match) {
        result.seriesName = match[1].trim();
        result.title = match[1].trim();
        result.seasonNumber = parseInt(match[2], 10);
        if (match[3]) {
          result.episodeTitle = match[3].trim();
        }
        return result;
      }

      match = rawTitle.match(/^(.+?)\s+(?:Staffel|Season)\s*(\d+)\s+(.+)$/i);
      if (match) {
        result.seriesName = match[1].trim();
        result.title = match[1].trim();
        result.seasonNumber = parseInt(match[2], 10);
        result.episodeTitle = match[3].trim();
        return result;
      }

      match = rawTitle.match(/^(.+?)\s*[-–]\s*.+?\s*\(\d+[-–]\d+\)\s+(.+)$/i);
      if (match) {
        result.seriesName = match[1].trim();
        result.title = match[1].trim();
        result.episodeTitle = match[2].trim();
        return result;
      }

      match = rawTitle.match(/^(.+?)\s*[-–]\s*(?:Episode\s*)?(\d+)\s*[-–]\s*(.+)$/i);
      if (match) {
        result.seriesName = match[1].trim();
        result.title = match[1].trim();
        result.episodeNumber = parseInt(match[2], 10);
        result.episodeTitle = match[3].trim();
        return result;
      }

      match = rawTitle.match(/^E(\d+)\s*[-–]\s*(.+)$/i);
      if (match) {
        result.episodeNumber = parseInt(match[1], 10);
        result.episodeTitle = match[2].trim();
        result.title = `Episode ${result.episodeNumber}: ${result.episodeTitle}`;
        return result;
      }

      match = rawTitle.match(/Season\s*(\d+)\s*Episode\s*(\d+)/i);
      if (match) {
        result.seasonNumber = parseInt(match[1], 10);
        result.episodeNumber = parseInt(match[2], 10);
        const titlePart = rawTitle.substring(0, rawTitle.indexOf(match[0])).trim();
        if (titlePart) {
          result.seriesName = titlePart.replace(/[-–:]\s*$/, '').trim();
          result.title = titlePart.replace(/[-–:]\s*$/, '').trim();
        }
        return result;
      }

      match = rawTitle.match(/S(\d+)[:\s]*E(\d+)/i);
      if (match) {
        result.seasonNumber = parseInt(match[1], 10);
        result.episodeNumber = parseInt(match[2], 10);
        const titlePart = rawTitle.substring(0, rawTitle.indexOf(match[0])).trim();
        if (titlePart) {
          result.seriesName = titlePart.replace(/[-–:]\s*$/, '').trim();
          result.title = titlePart.replace(/[-–:]\s*$/, '').trim();
        }
        return result;
      }

      return result;
    }

    function extractThumbnail(): string | null {
      const ogImage = document.querySelector('meta[property="og:image"]');
      if (ogImage) {
        const content = ogImage.getAttribute('content');
        if (content) return content;
      }

      return null;
    }

    function getFormattedTitle(): string {
      const metadata = extractCrunchyrollMetadata();
      if (metadata.seriesName) {
        cachedMetadata = metadata;
      }

      let formatted = metadata.title;

      if (metadata.seasonNumber && metadata.episodeNumber) {
        formatted = `${metadata.seriesName || metadata.title} S${metadata.seasonNumber}E${metadata.episodeNumber}`;
      } else if (metadata.seasonNumber) {
        formatted = `${metadata.seriesName || metadata.title} S${metadata.seasonNumber}`;
      } else if (metadata.episodeNumber) {
        formatted = `${metadata.seriesName || metadata.title} E${metadata.episodeNumber}`;
      }

      if (metadata.episodeTitle) {
        formatted += `: ${metadata.episodeTitle}`;
      }

      return formatted;
    }

    function getSeriesInfo(): { id: string | null; name: string | null; url: string | null } {
      const link = document.querySelector('[data-t="show-title-link"]') as HTMLAnchorElement | null
        || document.querySelector('a[href*="/series/"]') as HTMLAnchorElement | null;
      if (!link) return { id: null, name: null, url: null };
      const name = link.textContent?.trim() || null;
      const url = link.href || null;
      const idMatch = link.href?.match(/\/series\/([A-Z0-9]+)/i);
      return { id: idMatch?.[1] || null, name, url };
    }

    function findSeriesInNode(node: unknown): { id: string | null; name: string | null; url: string | null } | null {
      if (!node || typeof node !== 'object') return null;
      if (Array.isArray(node)) {
        for (const item of node) {
          const r = findSeriesInNode(item);
          if (r) return r;
        }
        return null;
      }
      const obj = node as Record<string, unknown>;
      if (obj['@type'] === 'TVSeries' && typeof obj.name === 'string') {
        const url = (typeof obj['@id'] === 'string' ? obj['@id'] : null)
                 || (typeof obj.url === 'string' ? obj.url : null);
        const idMatch = url?.match(/\/series\/([A-Z0-9]+)/i);
        return { id: idMatch?.[1] || null, name: obj.name, url };
      }
      if (obj['@type'] === 'TVEpisode' || obj['@type'] === 'Episode') {
        if (obj.partOfSeries) {
          const r = findSeriesInNode(obj.partOfSeries);
          if (r) return r;
        }
        if (obj.partOfSeason) {
          const season = obj.partOfSeason as Record<string, unknown>;
          if (season.partOfSeries) return findSeriesInNode(season.partOfSeries);
        }
      }
      return null;
    }

    function extractSeriesFromStructuredData(): { id: string | null; name: string | null; url: string | null } {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of Array.from(scripts)) {
        try {
          const data: unknown = JSON.parse(script.textContent || '');
          const result = findSeriesInNode(data);
          if (result) return result;
        } catch { /* ignore */ }
      }
      return { id: null, name: null, url: null };
    }

    let cachedVideoIdInIframe: string | null = null;
    let cachedTitleFromParent: string | null = null;
    let cachedSeriesNameFromParent: string | null = null;
    let cachedSeriesIdFromParent: string | null = null;
    let cachedSeriesUrlFromParent: string | null = null;
    let cachedThumbnailFromParent: string | null = null;
    let cachedEpisodeTextFromParent: string | null = null;
    let cachedWatchUrlFromParent: string | null = null;

    function getVideoId(): string | null {
      const isIframe = window !== window.top;

      if (isIframe) {
        if (cachedVideoIdInIframe) {
          return cachedVideoIdInIframe;
        }

        try {
          const videoIdFromAttr = window.frameElement?.getAttribute('data-jp343-video-id');
          if (videoIdFromAttr) {
            log('[JP343] iframe: Video ID found from attribute:', videoIdFromAttr);
            cachedVideoIdInIframe = videoIdFromAttr;
            return videoIdFromAttr;
          }
        } catch (e) {
          log('[JP343] iframe: No access to frameElement');
        }

        try {
          const parentUrl = window.parent.location.href;
          const match = parentUrl.match(/\/watch\/([A-Z0-9]+)/i);
          if (match) {
            log('[JP343] iframe: Video ID from parent via location:', match[1]);
            cachedVideoIdInIframe = match[1];
            return match[1];
          }
        } catch (e) {
          if (document.referrer) {
            const match = document.referrer.match(/\/watch\/([A-Z0-9]+)/i);
            if (match) {
              log('[JP343] iframe: Video ID from parent via referrer:', match[1]);
              cachedVideoIdInIframe = match[1];
              return match[1];
            }
          }
        }

        return null;
      }

      const match = window.location.pathname.match(/\/watch\/([A-Z0-9]+)/i);
      return match ? match[1] : null;
    }

    if (window !== window.top) {
      window.addEventListener('message', (event) => {
        if (!isAllowedOrigin(event.origin)) return;
        if (event.data && event.data.type === 'JP343_VIDEO_ID') {
          const videoId = event.data.videoId;
          const title = event.data.title;
          const thumbnail = event.data.thumbnail;
          const episodeText = event.data.episodeText;
          const watchUrl = event.data.watchUrl;

          if (videoId) {
            const isFirstTime = !cachedVideoIdInIframe;
            const videoIdChanged = cachedVideoIdInIframe && cachedVideoIdInIframe !== videoId;
            cachedVideoIdInIframe = videoId;

            if (videoIdChanged) {
              resetForNewVideo();
              log('[JP343] iframe: Video ID changed, bestKnownTitle reset');
            }

            if (title) {
              cachedTitleFromParent = title;
            }

            const seriesName = event.data.seriesName;
            const seriesId = event.data.seriesId;
            const seriesUrl = event.data.seriesUrl;
            if (seriesName) {
              cachedSeriesNameFromParent = seriesName;
              if (cachedMetadata && !cachedMetadata.seriesName) {
                cachedMetadata = null;
              }
            }
            if (seriesId) cachedSeriesIdFromParent = seriesId;
            if (seriesUrl) cachedSeriesUrlFromParent = seriesUrl;

            if (thumbnail) {
              cachedThumbnailFromParent = thumbnail;
            }

            if (watchUrl) {
              cachedWatchUrlFromParent = watchUrl;
            }

            if (episodeText) {
              cachedEpisodeTextFromParent = episodeText;
            }

            if (isFirstTime) {
              log('[JP343] iframe: Video ID received via postMessage:', videoId);
              if (title) {
                log('[JP343] iframe: Title received from parent:', title);
              }
              if (thumbnail) {
                log('[JP343] iframe: Thumbnail received from parent');
              }
              if (episodeText) {
                log('[JP343] iframe: Episode text from DOM:', episodeText);
              }
            }

            if (window.parent && event.source) {
              (event.source as Window).postMessage({
                type: 'JP343_VIDEO_ID_ACK',
                videoId: videoId
              }, event.origin || 'https://www.crunchyroll.com');
            }
          }
        }
      });

      let retryCount = 0;
      const maxRetries = 20;
      const videoIdChecker = setInterval(() => {
        retryCount++;
        const videoId = getVideoId();
        if (videoId) {
          log('[JP343] iframe: Video ID found after', retryCount, 'attempts:', videoId);
          clearInterval(videoIdChecker);
        } else if (retryCount >= maxRetries) {
          log('[JP343] iframe: Video ID not found after', maxRetries, 'attempts - waiting for postMessage');
          clearInterval(videoIdChecker);
        }
      }, 200);
    }

    function getCurrentVideoState(): VideoState | null {
      const video = findVideoElement();
      if (!video) return null;

      const videoId = getVideoId();
      if (!videoId) return null;

      const metadata = cachedMetadata || extractCrunchyrollMetadata();
      const seriesInfo = getSeriesInfo();
      const structuredSeries = seriesInfo.name ? null : extractSeriesFromStructuredData();

      const watchUrl = cachedWatchUrlFromParent || window.location.href;

      return {
        isPlaying: !video.paused && !video.ended,
        currentTime: video.currentTime,
        duration: video.duration || 0,
        title: getFormattedTitle(),
        url: watchUrl,
        platform: 'crunchyroll',
        isAd: isCurrentlyInAd || isAdPlaying(),
        thumbnailUrl: metadata.thumbnailUrl,
        videoId: videoId,
        channelId: cachedSeriesIdFromParent
          ? 'crunchyroll:' + cachedSeriesIdFromParent
          : (seriesInfo.id ? 'crunchyroll:' + seriesInfo.id
            : (structuredSeries?.id ? 'crunchyroll:' + structuredSeries.id
              : (structuredSeries?.name ? 'crunchyroll:' + structuredSeries.name
                : (metadata.seriesName ? 'crunchyroll:' + metadata.seriesName : null)))),
        channelName: cachedSeriesNameFromParent || seriesInfo.name || structuredSeries?.name || metadata.seriesName || null,
        channelUrl: cachedSeriesUrlFromParent || seriesInfo.url || structuredSeries?.url || null
      };
    }

    async function sendMessage(type: string, data?: Record<string, unknown>): Promise<void> {
      try {
        await browser.runtime.sendMessage({
          type,
          platform: 'crunchyroll',
          ...data
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes('Extension context invalidated')) return;
        log('[JP343] Message error:', error);
      }
    }

    function clearMetadataCache(): void {
      cachedMetadata = null;
    }

    function resetForNewVideo(): void {
      cachedMetadata = null;
      if (bestKnownTitle) {
        log('[JP343] Crunchyroll: bestKnownTitle reset on video change (was:', bestKnownTitle + ')');
        bestKnownTitle = '';
      }
    }

    function attachVideoEvents(video: HTMLVideoElement): void {
      if (video.hasAttribute('data-jp343-tracked')) {
        return;
      }
      video.setAttribute('data-jp343-tracked', 'true');

      video.addEventListener('play', () => {
        debugLog('VIDEO_PLAY', '=== VIDEO PLAY EVENT ===', collectUIState());

        const videoId = getVideoId();
        if (videoId && lastVideoId && videoId !== lastVideoId) {
          resetForNewVideo();
        } else {
          clearMetadataCache();
        }

        if (isAdPlaying() || isCurrentlyInAd) {
          debugLog('VIDEO_PLAY', 'Play during ad - ignored', { videoId, isCurrentlyInAd, isAdPlaying: isAdPlaying() });
          log('[JP343] Crunchyroll Play during ad - ignored, Video ID saved:', videoId);
          pendingVideoId = videoId;
          if (!isCurrentlyInAd) {
            isCurrentlyInAd = true;
            sendMessage('AD_START');
          }
          return;
        }

        const state = getCurrentVideoState();
        if (state) {
          lastVideoId = videoId;
          debugLog('VIDEO_PLAY', 'Tracking started', { videoId, title: state.title });
          log('[JP343] Crunchyroll Play:', state.title, '(ID:', lastVideoId, ')');
          sendVideoPlay(state);
        }
      });

      video.addEventListener('pause', () => {
        debugLog('VIDEO_PAUSE', '=== VIDEO PAUSE EVENT ===', collectUIState());
        sendMessage('VIDEO_PAUSE');
      });

      video.addEventListener('ended', () => {
        debugLog('VIDEO_ENDED', '=== VIDEO ENDED EVENT ===', collectUIState());

        // Don't send VIDEO_ENDED during ads
        if (isCurrentlyInAd) {
          debugLog('VIDEO_ENDED', 'Ended during ad - ignored', { isCurrentlyInAd });
          log('[JP343] Crunchyroll Video ended during ad - ignored');
          return;
        }
        sendMessage('VIDEO_ENDED');
        clearMetadataCache();
      });

      video.addEventListener('loadedmetadata', () => {
        debugLog('VIDEO_META', '=== VIDEO LOADEDMETADATA ===', {
          duration: video.duration,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
          ...collectUIState()
        });
      });

      video.addEventListener('seeking', () => {
        debugLog('VIDEO_SEEK', 'Seeking', { currentTime: video.currentTime });
      });

      if (stateUpdateIntervalId) clearInterval(stateUpdateIntervalId);
      stateUpdateIntervalId = setInterval(() => {
        if (isCurrentlyInAd) {
          return;
        }

        const state = getCurrentVideoState();
        if (state && state.isPlaying) {
          const currentVideoId = getVideoId();

          if (currentVideoId && lastVideoId && currentVideoId !== lastVideoId) {
            log('[JP343] Crunchyroll Video change (ID):', lastVideoId, '->', currentVideoId);
            lastVideoId = currentVideoId;
            resetForNewVideo();
            sendMessage('VIDEO_ENDED');
            setTimeout(() => {
              const newState = getCurrentVideoState();
              if (newState && newState.isPlaying && !isCurrentlyInAd) {
                sendVideoPlay(newState);
              }
            }, 500);
          } else {
            sendMessage('VIDEO_STATE_UPDATE', { state });
          }
        }
      }, 30000);

      log('[JP343] Crunchyroll Video events bound');
      sendDiagnostic('player_found');
    }

    const observer = new MutationObserver(() => {
      const video = findVideoElement();

      if (video && video !== currentVideoElement) {
        currentVideoElement = video;
        clearMetadataCache();
        attachVideoEvents(video);
        const videoId = getVideoId();

        if (!video.paused && !video.ended && videoId) {
          if (isAdPlaying() || isCurrentlyInAd) {
            debugLog('OBSERVER', 'New video during ad', { videoId });
            log('[JP343] Crunchyroll: New video during ad detected, ID saved:', videoId);
            pendingVideoId = videoId;
            if (!isCurrentlyInAd) {
              isCurrentlyInAd = true;
              sendMessage('AD_START');
            }
          } else {
            log('[JP343] Crunchyroll: New video already playing');
            lastVideoId = videoId;
            const state = getCurrentVideoState();
            if (state) {
              sendVideoPlay(state);
            }
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    observers.push(observer);

    const initialVideo = findVideoElement();
    if (initialVideo) {
      currentVideoElement = initialVideo;
      attachVideoEvents(initialVideo);
      const videoId = getVideoId();

      if (!initialVideo.paused && !initialVideo.ended && videoId) {
        if (isAdPlaying()) {
          log('[JP343] Crunchyroll: Video already playing during ad');
          isCurrentlyInAd = true;
          pendingVideoId = videoId;
          sendMessage('AD_START');
        } else {
          log('[JP343] Crunchyroll: Video already playing, starting tracking');
          lastVideoId = videoId;
          const state = getCurrentVideoState();
          if (state) {
            sendVideoPlay(state);
          }
        }
      }
    }

    let lastUrl = window.location.href;
    intervalIds.push(setInterval(() => {
      if (window.location.href !== lastUrl) {
        const oldUrl = lastUrl;
        const newUrl = window.location.href;
        const wasOnWatch = oldUrl.includes('/watch/');
        const isOnWatch = newUrl.includes('/watch/');

        debugLog('URL_CHANGE', '=== URL CHANGED ===', {
          oldUrl, newUrl, wasOnWatch, isOnWatch,
          ...collectUIState()
        });
        log('[JP343] Crunchyroll URL change:', oldUrl, '->', newUrl);
        lastUrl = newUrl;

        if (wasOnWatch && !isOnWatch) {
          log('[JP343] Crunchyroll: Left /watch/ - ending session');
          sendMessage('VIDEO_ENDED');
          resetForNewVideo();
          return;
        }

        resetForNewVideo();

        if (isOnWatch) {
          setTimeout(() => {
            const video = findVideoElement();
            if (video && video !== currentVideoElement) {
              debugLog('URL_CHANGE', 'New video detected after URL change', collectUIState());
              currentVideoElement = video;
              attachVideoEvents(video);
              lastVideoId = getVideoId();
            }
          }, 1000);
        }
      }
    }, 1000));

    const titleObserver = new MutationObserver(() => {
      const docTitle = document.title;
      if (docTitle && docTitle.toLowerCase() !== 'crunchyroll' && !docTitle.toLowerCase().includes('home')) {
        const cleanTitle = docTitle
          .replace(/\s*[-–—|]\s*(?:\S+\s+){0,3}Crunchyroll\b.*$/i, '')
          .trim();
        if (cleanTitle && cleanTitle.length > 2 && cleanTitle.toLowerCase() !== 'crunchyroll') {
          if (cleanTitle !== bestKnownTitle) {
            log('[JP343] Crunchyroll: New title detected:', cleanTitle);
            bestKnownTitle = cleanTitle;
            clearMetadataCache();
          }
        }
      }
    });

    const titleElement = document.querySelector('title');
    if (titleElement) {
      titleObserver.observe(titleElement, { childList: true, characterData: true, subtree: true });
      observers.push(titleObserver);
    }

    let titleCheckCount = 0;
    const titleCheckInterval = setInterval(() => {
      titleCheckCount++;
      const docTitle = document.title;
      if (docTitle && docTitle.toLowerCase() !== 'crunchyroll') {
        const cleanTitle = docTitle
          .replace(/\s*[-|–]\s*Watch on Crunchyroll.*$/i, '')
          .replace(/\s*[-|–]\s*Crunchyroll.*$/i, '')
          .trim();
        if (cleanTitle && cleanTitle.length > 2 && cleanTitle !== bestKnownTitle) {
          log('[JP343] Crunchyroll: Title found (check #' + titleCheckCount + '):', cleanTitle);
          bestKnownTitle = cleanTitle;
          clearMetadataCache();
        }
      }
      if (titleCheckCount >= 6) {
        clearInterval(titleCheckInterval);
      }
    }, 5000);
    intervalIds.push(titleCheckInterval);

    setTimeout(() => {
      const video = findVideoElement();
      const videoId = getVideoId();
      const metadata = extractCrunchyrollMetadata();
      const adPlaying = isAdPlaying();
      log('[JP343] Crunchyroll Debug:', {
        documentTitle: document.title,
        bestKnownTitle: bestKnownTitle,
        videoFound: !!video,
        videoPlaying: video ? !video.paused : false,
        videoId: videoId,
        url: window.location.href,
        extractedMetadata: metadata,
        isCurrentlyInAd: isCurrentlyInAd,
        adDetected: adPlaying,
        pendingVideoId: pendingVideoId
      });

      if (video && !video.paused && !video.ended && videoId && !adPlaying && !isCurrentlyInAd) {
        const state = getCurrentVideoState();
        if (state) {
          log('[JP343] Crunchyroll: Starting delayed tracking');
          lastVideoId = videoId;
          sendVideoPlay(state);
        }
      } else if (video && !video.paused && (adPlaying || isCurrentlyInAd) && videoId) {
        log('[JP343] Crunchyroll: Video playing during ad - tracking paused');
        pendingVideoId = videoId;
      }
    }, 3000);

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
