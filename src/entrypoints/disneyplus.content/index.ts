import type { VideoState } from '../../types';
import { createDebugLogger } from '../../lib/debug-logger';
import { parseSeasonOnly } from '../../lib/title-parsing';

interface DisneyPlusMetadata {
  title: string;
  episodeTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  isMovie: boolean;
  seriesName: string | null;
  thumbnailUrl: string | null;
}

export default defineContentScript({
  matches: ['*://*.disneyplus.com/*'],
  runAt: 'document_idle',

  main() {
    let currentVideoElement: HTMLVideoElement | null = null;
    let lastTitle: string = '';
    let lastVideoId: string | null = null;
    let isCurrentlyInAd: boolean = false;
    let bestKnownSeriesName: string = '';
    let cachedMetadata: DisneyPlusMetadata | null = null;
    let interceptedTitle: string | null = null;
    let interceptedSubtitle: string | null = null;

    let interceptedThumbnail: string | null = null;

    window.addEventListener('jp343-disney-meta', ((event: CustomEvent<{ title: string; subtitle: string | null; thumbnail: string | null }>) => {
      interceptedTitle = event.detail.title;
      interceptedSubtitle = event.detail.subtitle;
      if (event.detail.thumbnail) interceptedThumbnail = event.detail.thumbnail;
      if (interceptedTitle && interceptedTitle !== bestKnownSeriesName) {
        bestKnownSeriesName = interceptedTitle;
        cachedMetadata = null;
      }
      log('[JP343] Disney+: Intercepted metadata:', interceptedTitle, interceptedSubtitle, interceptedThumbnail?.substring(0, 60));
    }) as EventListener);

    const observers: MutationObserver[] = [];
    const intervalIds: ReturnType<typeof setInterval>[] = [];
    let adEndDebounce: ReturnType<typeof setTimeout> | null = null;
    function cleanup(): void {
      observers.forEach(o => o.disconnect());
      intervalIds.forEach(clearInterval);
      observers.length = 0;
      intervalIds.length = 0;
      if (adEndDebounce) clearTimeout(adEndDebounce);
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

    const { log } = createDebugLogger('disneyplus');

    function findVideoElement(): HTMLVideoElement | null {
      return (document.querySelector('video.hive-video') as HTMLVideoElement)
        || (document.querySelector('.btm-media-client video[src]') as HTMLVideoElement)
        || null;
    }

    function isWatchPage(): boolean {
      return window.location.pathname.includes('/play/');
    }

    function getVideoId(): string | null {
      const match = window.location.pathname.match(/\/play\/([a-f0-9-]{36})/i);
      return match ? match[1] : null;
    }

    function parseDisneyTitle(rawTitle: string): Partial<DisneyPlusMetadata> {
      const result: Partial<DisneyPlusMetadata> = {
        title: rawTitle,
        seriesName: rawTitle,
        isMovie: true
      };

      let match;

      match = rawTitle.match(/^(.+?)\s*[-–]\s*S(\d+):?[EF](\d+)\s*[-–:]?\s*(.*)$/i);
      if (match) {
        result.seriesName = match[1].trim();
        result.title = match[1].trim();
        result.seasonNumber = parseInt(match[2], 10);
        result.episodeNumber = parseInt(match[3], 10);
        result.episodeTitle = match[4].trim() || null;
        result.isMovie = false;
        return result;
      }

      match = rawTitle.match(/^(.+?)\s*[-–]\s*Season\s*(\d+)[,:]?\s*Episode\s*(\d+)(.*)$/i);
      if (match) {
        result.seriesName = match[1].trim();
        result.title = match[1].trim();
        result.seasonNumber = parseInt(match[2], 10);
        result.episodeNumber = parseInt(match[3], 10);
        result.episodeTitle = match[4].replace(/^[\s:–-]+/, '').trim() || null;
        result.isMovie = false;
        return result;
      }

      match = rawTitle.match(/^(.+?)\s*[-–]\s*Staffel\s*(\d+)[,:]?\s*Folge\s*(\d+)(.*)$/i);
      if (match) {
        result.seriesName = match[1].trim();
        result.title = match[1].trim();
        result.seasonNumber = parseInt(match[2], 10);
        result.episodeNumber = parseInt(match[3], 10);
        result.episodeTitle = match[4].replace(/^[\s:–-]+/, '').trim() || null;
        result.isMovie = false;
        return result;
      }

      match = rawTitle.match(/^(.+?)\s*シーズン\s*(\d+)\s*エピソード\s*(\d+)(.*)$/);
      if (match) {
        result.seriesName = match[1].trim();
        result.title = match[1].trim();
        result.seasonNumber = parseInt(match[2], 10);
        result.episodeNumber = parseInt(match[3], 10);
        result.episodeTitle = match[4].trim() || null;
        result.isMovie = false;
        return result;
      }

      match = rawTitle.match(/^(.+?)\s*第(\d+)話(.*)$/);
      if (match) {
        result.seriesName = match[1].trim();
        result.title = match[1].trim();
        result.episodeNumber = parseInt(match[2], 10);
        result.episodeTitle = match[3].trim() || null;
        result.isMovie = false;
        return result;
      }

      match = rawTitle.match(/S(\d+)\s*[:\s]?\s*[EF](\d+)/i);
      if (match) {
        result.seasonNumber = parseInt(match[1], 10);
        result.episodeNumber = parseInt(match[2], 10);
        const titlePart = rawTitle.substring(0, rawTitle.indexOf(match[0])).trim();
        if (titlePart) {
          result.seriesName = titlePart.replace(/[-–:,]\s*$/, '').trim();
          result.title = result.seriesName;
        }
        result.isMovie = false;
        return result;
      }

      match = rawTitle.match(/Season\s*(\d+)[,:]?\s*Episode\s*(\d+)/i);
      if (match) {
        result.seasonNumber = parseInt(match[1], 10);
        result.episodeNumber = parseInt(match[2], 10);
        const titlePart = rawTitle.substring(0, rawTitle.indexOf(match[0])).trim();
        if (titlePart) {
          result.seriesName = titlePart.replace(/[-–:,]\s*$/, '').trim();
          result.title = result.seriesName;
        }
        result.isMovie = false;
        return result;
      }

      const seasonOnly = parseSeasonOnly(rawTitle);
      if (seasonOnly) {
        result.seriesName = seasonOnly.seriesName;
        result.title = seasonOnly.seriesName;
        result.seasonNumber = seasonOnly.seasonNumber;
        result.isMovie = false;
        return result;
      }

      return result;
    }

    function parseEpisodeInfo(text: string): {
      seasonNumber: number | null;
      episodeNumber: number | null;
      episodeTitle: string | null;
    } {
      const result = {
        seasonNumber: null as number | null,
        episodeNumber: null as number | null,
        episodeTitle: null as string | null
      };

      const patterns: [RegExp, boolean][] = [
        [/S(\d+)\s*[:\s]?\s*[EF](\d+)/i, true],
        [/Season\s*(\d+)[,:]?\s*Episode\s*(\d+)/i, true],
        [/Staffel\s*(\d+)[,:]?\s*Folge\s*(\d+)/i, true],
        [/シーズン\s*(\d+)\s*エピソード\s*(\d+)/, true],
        [/(\d+)x(\d+)/, true],
        [/Ep\.?\s*(\d+)/i, false],
        [/Episode\s*(\d+)/i, false],
        [/Folge\s*(\d+)/i, false],
        [/エピソード\s*(\d+)/, false],
        [/第(\d+)話/, false],
      ];

      for (const [pattern, hasSeason] of patterns) {
        const match = text.match(pattern);
        if (match) {
          if (hasSeason && match[2]) {
            result.seasonNumber = parseInt(match[1], 10);
            result.episodeNumber = parseInt(match[2], 10);
          } else {
            result.episodeNumber = parseInt(match[1], 10);
          }
          const rest = text.replace(match[0], '').replace(/^[\s:–-]+/, '').trim();
          if (rest && rest.length > 1) {
            result.episodeTitle = rest;
          }
          break;
        }
      }

      return result;
    }

    function probePlayerTitle(): void {
      const titleSelectors = [
        '[data-testid="title-field"]',
        '[data-testid="content-title"]',
        '[data-testid="infobar-title"]',
        '[data-gv2elementtype="title"]',
        '.title-field',
      ];

      for (const selector of titleSelectors) {
        const el = document.querySelector(selector);
        const text = el?.textContent?.trim();
        if (text && text.length > 1 && text !== 'Disney+ Content') {
          if (text !== bestKnownSeriesName) {
            log('[JP343] Disney+: Player title via', selector, ':', text);
            bestKnownSeriesName = text;
            cachedMetadata = null;
          }
          return;
        }
      }
    }

    function extractDisneyMetadata(): DisneyPlusMetadata {
      if (cachedMetadata) return cachedMetadata;

      const metadata: DisneyPlusMetadata = {
        title: 'Disney+ Content',
        episodeTitle: null,
        seasonNumber: null,
        episodeNumber: null,
        isMovie: true,
        seriesName: null,
        thumbnailUrl: null
      };

      const docTitle = document.title;
      if (docTitle) {
        const cleaned = docTitle
          .replace(/\s*\|\s*Disney\+.*$/i, '')
          .replace(/\s*[-–]\s*Disney\+.*$/i, '')
          .trim();
        if (cleaned && cleaned.length > 1) {
          const parsed = parseDisneyTitle(cleaned);
          Object.assign(metadata, parsed);
        }
      }

      if (interceptedTitle) {
        metadata.seriesName = interceptedTitle;
        metadata.title = interceptedTitle;
        bestKnownSeriesName = interceptedTitle;
      }

      probePlayerTitle();
      if (!metadata.seriesName && bestKnownSeriesName) {
        metadata.seriesName = bestKnownSeriesName;
        metadata.title = bestKnownSeriesName;
      }

      if (!metadata.episodeNumber && interceptedSubtitle) {
        const epInfo = parseEpisodeInfo(interceptedSubtitle);
        if (epInfo.episodeNumber) {
          metadata.seasonNumber = epInfo.seasonNumber;
          metadata.episodeNumber = epInfo.episodeNumber;
          metadata.episodeTitle = epInfo.episodeTitle;
          metadata.isMovie = false;
        }
      }

      if (!metadata.episodeNumber) {
        const subtitleSelectors = [
          '[data-testid="subtitle-field"]',
          '[data-testid="content-subtitle"]',
          '[data-gv2elementtype="subtitle"]',
          '.subtitle-field',
        ];
        for (const selector of subtitleSelectors) {
          const el = document.querySelector(selector);
          const text = el?.textContent?.trim();
          if (text && text.length > 1) {
            const epInfo = parseEpisodeInfo(text);
            if (epInfo.episodeNumber) {
              metadata.seasonNumber = epInfo.seasonNumber;
              metadata.episodeNumber = epInfo.episodeNumber;
              metadata.episodeTitle = epInfo.episodeTitle;
              metadata.isMovie = false;
              log('[JP343] Disney+: Episode info from player:', text);
              break;
            }
          }
        }
      }

      if (!metadata.seriesName && metadata.title !== 'Disney+ Content') {
        metadata.seriesName = metadata.title;
        bestKnownSeriesName = metadata.title;
      }

      if (metadata.title === 'Disney+ Content' && bestKnownSeriesName) {
        metadata.title = bestKnownSeriesName;
        metadata.seriesName = bestKnownSeriesName;
      }

      if (!metadata.seriesName) {
        const ogTitle = document.querySelector('meta[property="og:title"]');
        const ogText = ogTitle?.getAttribute('content')?.trim();
        if (ogText && ogText.length > 1) {
          const parsed = parseDisneyTitle(ogText);
          if (parsed.seriesName) {
            metadata.seriesName = parsed.seriesName;
            if (metadata.title === 'Disney+ Content') {
              metadata.title = parsed.title || parsed.seriesName;
            }
            bestKnownSeriesName = parsed.seriesName;
          }
        }
      }

      metadata.thumbnailUrl = getThumbnail();
      cachedMetadata = metadata;
      return metadata;
    }

    function getFormattedTitle(): string {
      const metadata = extractDisneyMetadata();

      if (metadata.isMovie) {
        return metadata.title;
      }

      let formatted = metadata.seriesName || metadata.title;
      if (metadata.seasonNumber && metadata.episodeNumber) {
        formatted += ` S${metadata.seasonNumber}E${metadata.episodeNumber}`;
      } else if (metadata.episodeNumber) {
        formatted += ` E${metadata.episodeNumber}`;
      } else if (metadata.seasonNumber) {
        formatted += ` S${metadata.seasonNumber}`;
      }
      if (metadata.episodeTitle) {
        formatted += `: ${metadata.episodeTitle}`;
      }
      return formatted;
    }

    function getThumbnail(): string | null {
      if (interceptedThumbnail) return interceptedThumbnail;
      const ogImage = document.querySelector('meta[property="og:image"]') as HTMLMetaElement;
      if (ogImage?.content && ogImage.content.startsWith('https://')) {
        return ogImage.content;
      }
      return null;
    }

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

    function startTrackingIfContentPlaying(): void {
      if (isCurrentlyInAd) return;
      const video = findVideoElement();
      const videoId = getVideoId();
      if (video && !video.paused && !video.ended && videoId) {
        if (!lastVideoId) {
          lastVideoId = videoId;
          lastTitle = getFormattedTitle();
          const state = getCurrentVideoState();
          if (state && !state.isAd) {
            log('[JP343] Disney+: Auto-tracking after ad:', state.title);
            sendMessage('VIDEO_PLAY', { state });
          }
        }
      }
    }

    function handleAdStateChange(): void {
      const adPlaying = isAdPlaying();

      if (adPlaying) {
        if (adEndDebounce) {
          clearTimeout(adEndDebounce);
          adEndDebounce = null;
        }
        if (!isCurrentlyInAd) {
          isCurrentlyInAd = true;
          log('[JP343] Disney+: Ad started');
          sendMessage('AD_START');
        }
      } else if (isCurrentlyInAd && !adEndDebounce) {
        adEndDebounce = setTimeout(() => {
          adEndDebounce = null;
          if (!isAdPlaying()) {
            isCurrentlyInAd = false;
            log('[JP343] Disney+: Ad break ended');
            sendMessage('AD_END');
            setTimeout(() => startTrackingIfContentPlaying(), 1500);
          }
        }, 3000);
      }
    }

    intervalIds.push(setInterval(handleAdStateChange, 500));

    intervalIds.push(setInterval(() => {
      if (!isWatchPage() || !lastVideoId) return;
      const before = bestKnownSeriesName;
      probePlayerTitle();
      if (bestKnownSeriesName && bestKnownSeriesName !== before) {
        const state = getCurrentVideoState();
        if (state && state.isPlaying && !isCurrentlyInAd) {
          lastTitle = state.title;
          sendMessage('VIDEO_STATE_UPDATE', { state });
        }
      }
    }, 3000));

    function getCurrentVideoState(): VideoState | null {
      const video = findVideoElement();
      if (!video) return null;

      const videoId = getVideoId();
      if (!videoId) return null;

      const metadata = cachedMetadata || extractDisneyMetadata();

      return {
        isPlaying: !video.paused && !video.ended,
        currentTime: video.currentTime,
        duration: video.duration || 0,
        title: getFormattedTitle(),
        url: window.location.href,
        platform: 'disneyplus',
        isAd: isCurrentlyInAd || isAdPlaying(),
        thumbnailUrl: metadata.thumbnailUrl,
        videoId: videoId,
        channelId: metadata.seriesName ? 'disneyplus:' + metadata.seriesName : null,
        channelName: metadata.seriesName || null,
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
        if (error instanceof Error && error.message.includes('Extension context invalidated')) return;
        log('[JP343] Disney+: Message error:', error);
      }
    }

    function attachVideoEvents(video: HTMLVideoElement): void {
      if (video.hasAttribute('data-jp343-tracked')) return;
      video.setAttribute('data-jp343-tracked', 'true');

      video.addEventListener('play', () => {
        if (!isWatchPage()) {
          log('[JP343] Disney+: Play on non-watch page ignored');
          return;
        }

        if (isAdPlaying() || isCurrentlyInAd) {
          log('[JP343] Disney+: Play during ad ignored');
          if (!isCurrentlyInAd) {
            isCurrentlyInAd = true;
            sendMessage('AD_START');
          }
          return;
        }

        const videoId = getVideoId();
        if (videoId && lastVideoId && videoId !== lastVideoId) {
          sendMessage('VIDEO_ENDED');
          bestKnownSeriesName = '';
          cachedMetadata = null;
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
          log('[JP343] Disney+: Ended during ad ignored');
          return;
        }
        sendMessage('VIDEO_ENDED');
        lastVideoId = null;
      });

      const updateInterval = setInterval(() => {
        if (isCurrentlyInAd || !isWatchPage()) return;

        const state = getCurrentVideoState();
        if (state && state.isPlaying) {
          const currentVideoId = getVideoId();
          if (currentVideoId && lastVideoId && currentVideoId !== lastVideoId) {
            log('[JP343] Disney+: Video switch:', lastVideoId, '->', currentVideoId);
            sendMessage('VIDEO_ENDED');
            bestKnownSeriesName = '';
            cachedMetadata = null;
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

      log('[JP343] Disney+: Events bound');
    }

    const observer = new MutationObserver(() => {
      if (!isWatchPage()) return;

      const video = findVideoElement();
      if (video && video !== currentVideoElement) {
        currentVideoElement = video;
        attachVideoEvents(video);
        const videoId = getVideoId();

        if (!video.paused && !video.ended && videoId) {
          if (isAdPlaying() || isCurrentlyInAd) {
            log('[JP343] Disney+: New video during ad');
            if (!isCurrentlyInAd) {
              isCurrentlyInAd = true;
              sendMessage('AD_START');
            }
          } else {
            log('[JP343] Disney+: Video already playing');
            lastVideoId = videoId;
            lastTitle = getFormattedTitle();
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
            lastTitle = getFormattedTitle();
            const state = getCurrentVideoState();
            if (state) {
              log('[JP343] Disney+: Initial video playing');
              sendMessage('VIDEO_PLAY', { state });
            }
          }
        }
      }
    }

    let lastUrl = window.location.href;
    intervalIds.push(setInterval(() => {
      if (window.location.href !== lastUrl) {
        const oldUrl = lastUrl;
        const newUrl = window.location.href;
        const wasOnWatch = oldUrl.includes('/play/');
        const isOnWatch = newUrl.includes('/play/');

        log('[JP343] Disney+: URL change:', oldUrl, '->', newUrl);
        lastUrl = newUrl;

        if (wasOnWatch && !isOnWatch) {
          log('[JP343] Disney+: Left watch page');
          sendMessage('VIDEO_ENDED');
          lastVideoId = null;
          lastTitle = '';
          isCurrentlyInAd = false;
          if (adEndDebounce) { clearTimeout(adEndDebounce); adEndDebounce = null; }
          bestKnownSeriesName = '';
          cachedMetadata = null;
          return;
        }

        if (isOnWatch) {
          lastVideoId = null;
          lastTitle = '';
          isCurrentlyInAd = false;
          if (adEndDebounce) { clearTimeout(adEndDebounce); adEndDebounce = null; }
          bestKnownSeriesName = '';
          cachedMetadata = null;

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
                  lastTitle = getFormattedTitle();
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

    const titleElement = document.querySelector('title');
    if (titleElement) {
      const titleObserver = new MutationObserver(() => {
        if (!isWatchPage()) return;
        cachedMetadata = null;
        const newTitle = getFormattedTitle();
        if (newTitle !== 'Disney+ Content' && newTitle !== lastTitle && lastVideoId) {
          log('[JP343] Disney+: New title:', newTitle);
          lastTitle = newTitle;
        }
      });
      titleObserver.observe(titleElement, { childList: true, characterData: true, subtree: true });
      observers.push(titleObserver);
    }

    setTimeout(() => {
      if (!isWatchPage()) return;
      const video = findVideoElement();
      const videoId = getVideoId();
      if (video && !video.paused && !video.ended && videoId && !isAdPlaying() && !isCurrentlyInAd && !lastVideoId) {
        log('[JP343] Disney+: Delayed tracking pickup');
        lastVideoId = videoId;
        lastTitle = getFormattedTitle();
        const state = getCurrentVideoState();
        if (state) {
          sendMessage('VIDEO_PLAY', { state });
        }
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
