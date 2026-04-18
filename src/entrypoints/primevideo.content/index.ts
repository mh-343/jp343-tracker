// JP343 Extension - Amazon Prime Video Content Script

import type { VideoState } from '../../types';
import { createDebugLogger, setupDebugCommands, DEBUG_MODE } from '../../lib/debug-logger';
import { parseSeasonOnly } from '../../lib/title-parsing';

interface PrimeVideoMetadata {
  title: string;
  episodeTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  isMovie: boolean;
  thumbnailUrl: string | null;
}

export default defineContentScript({
  matches: [
    '*://*.primevideo.com/*',
    '*://*.amazon.com/*',
    '*://*.amazon.de/*',
    '*://*.amazon.co.jp/*',
    '*://*.amazon.com.br/*'
  ],
  runAt: 'document_idle',

  main() {
    let currentVideoElement: HTMLVideoElement | null = null;
    let lastTitle: string = '';
    let lastVideoId: string | null = null;
    let bestKnownTitle: string = '';
    let isCurrentlyInAd: boolean = false;
    let recentAdEnd: number = 0;
    let effectiveUrl: string = window.location.href;
    let episodeChangeCounter = 0;
    let lastEpisodeChangeTime = 0;
    let lastCurrentTime = 0;
    let lastSubtitleText = '';

    function findVideoElement(): HTMLVideoElement | null {
      return (document.querySelector('.dv-player-fullscreen video') as HTMLVideoElement)
        || (document.querySelector('[data-testid="web-player"] video') as HTMLVideoElement)
        || (document.querySelector('.webPlayerSDKContainer video') as HTMLVideoElement)
        || null;
    }


    function isPlayerActive(): boolean {
      return !!(document.querySelector('.dv-player-fullscreen')
        || document.querySelector('.webPlayerSDKContainer')
        || document.querySelector('[data-testid="web-player"]'));
    }

    const observers: MutationObserver[] = [];
    const intervalIds: ReturnType<typeof setInterval>[] = [];
    function cleanup(): void {
      observers.forEach(o => o.disconnect());
      intervalIds.forEach(clearInterval);
      observers.length = 0;
      intervalIds.length = 0;
    }
    window.addEventListener('pagehide', () => {
      if (lastVideoId) {
        log('[JP343] Prime Video: Page is being left - VIDEO_ENDED');
        sendMessage('VIDEO_ENDED');
      }
      cleanup();
    });
    window.addEventListener('beforeunload', () => {
      if (lastVideoId) {
        log('[JP343] Prime Video: beforeunload - VIDEO_ENDED');
        sendMessage('VIDEO_ENDED');
      }
    });

    const logger = createDebugLogger('primevideo');
    const { log, debugLog } = logger;
    log('[JP343] Prime Video Content Script loaded');
    setupDebugCommands(logger, 'primevideo');

    const isIncognito = browser.extension?.inIncognitoContext ?? false;
    function sendDiagnostic(code: string): void {
      if (isIncognito) return;
      try {
        browser.runtime.sendMessage({ type: 'DIAGNOSTIC_EVENT', code, platform: 'primevideo' }).catch(() => {});
      } catch { /* best-effort */ }
    }
    sendDiagnostic('content_script_loaded');

    function collectUIState(): Record<string, unknown> {
      const video = findVideoElement();
      return {
        videoExists: !!video,
        videoPaused: video?.paused ?? null,
        videoEnded: video?.ended ?? null,
        videoDuration: video?.duration ?? null,
        videoCurrentTime: video?.currentTime ?? null,
        url: window.location.href,
        videoIdFromUrl: getVideoId(),
        documentTitle: document.title,
        isCurrentlyInAd,
        lastVideoId,
        bestKnownTitle,
        effectiveUrl,
        episodeChangeCounter,
        lastCurrentTime,
        adTimerVisible: !!document.querySelector('[data-testid="ad-timer"], .atvwebplayersdk-ad-timer, .adTimerText'),
        playerTitleEl: document.querySelector('[data-testid="title-text"], .atvwebplayersdk-title-text')?.textContent?.trim() || null,
        playerSubtitleEl: document.querySelector('[data-testid="subtitle-text"], .atvwebplayersdk-subtitle-text')?.textContent?.trim() || null,
        allDataTestIds: Array.from(document.querySelectorAll('[data-testid]'))
          .filter(el => (el as HTMLElement).offsetParent !== null)
          .slice(0, 30)
          .map(el => el.getAttribute('data-testid'))
      };
    }

    if (DEBUG_MODE) {
      const debugMutationObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              const dataTestId = node.getAttribute?.('data-testid');
              const classes = node.className || '';
              const innerText = node.innerText?.slice(0, 50) || '';
              const isInteresting =
                dataTestId ||
                /ad|skip|interstitial|overlay|countdown|timer/i.test(classes) ||
                /Werbung|^Ad\s/i.test(innerText);
              if (isInteresting) {
                debugLog('DOM_ADD', 'New element', {
                  tag: node.tagName,
                  dataTestId,
                  classes,
                  id: node.id,
                  innerText: node.innerText?.slice(0, 100),
                  visible: node.offsetParent !== null
                });
              }
            }
          });
          mutation.removedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              const dataTestId = node.getAttribute?.('data-testid');
              if (dataTestId && /ad|skip|interstitial/i.test(dataTestId)) {
                debugLog('DOM_REMOVE', 'Element removed', { tag: node.tagName, dataTestId });
              }
            }
          });
        });
      });
      debugMutationObserver.observe(document.body, { childList: true, subtree: true });
      observers.push(debugMutationObserver);
      debugLog('INIT', 'Debug Mutation Observer started');

      intervalIds.push(setInterval(() => {
        const video = findVideoElement();
        if (video && !video.paused) {
          debugLog('PERIODIC', 'State-Check', collectUIState());
        }
      }, 5000));
    }

    function isWatchPage(): boolean {
      const path = window.location.pathname;
      const hostname = window.location.hostname;

      if (hostname.includes('primevideo.com')) {
        return path.includes('/detail/') || path.includes('/dp/');
      }

      if (hostname.includes('amazon.')) {
        return path.includes('/gp/video/detail/') || path.includes('/gp/video/dp/');
      }

      return false;
    }

    function getVideoId(): string | null {
      const path = window.location.pathname;
      const asinMatch = path.match(/\/(?:detail|dp)\/([A-Z0-9]{10,})/i);
      return asinMatch ? asinMatch[1] : null;
    }

    const GENERIC_TITLES = new Set([
      'prime video', 'amazon prime video', 'amazon prime',
      'filme und serien', 'movies and tv', 'movies & tv',
      'home', 'startseite', 'meine videos', 'my stuff',
      'store', 'categories', 'kategorien', 'channels'
    ]);

    function isGenericTitle(title: string): boolean {
      if (!title || title === 'Prime Video Content') return true;
      const lower = title.toLowerCase().trim();
      if (lower.length < 2) return true;
      return GENERIC_TITLES.has(lower);
    }

    function extractMetadata(): PrimeVideoMetadata {
      const metadata: PrimeVideoMetadata = {
        title: 'Prime Video Content',
        episodeTitle: null,
        seasonNumber: null,
        episodeNumber: null,
        isMovie: true,
        thumbnailUrl: null
      };

      const docTitle = document.title;
      if (!isGenericTitle(docTitle)) {
        const cleanTitle = docTitle
          .replace(/\s*[\|–-]\s*(?:Prime Video|Amazon Prime Video|Amazon\.?\w*).*$/i, '')
          .replace(/^(?:Amazon\.\w+:\s*)/i, '')
          .replace(/\s+ansehen$|\s+anschauen$/i, '')
          .replace(/^(?:Watch|Ansehen|Regarder|Ver|Guarda)\s+/i, '')
          .trim();
        if (cleanTitle && cleanTitle.length > 0 && !isGenericTitle(cleanTitle)) {
          const parsed = parsePrimeTitle(cleanTitle);
          Object.assign(metadata, parsed);
          if (metadata.title !== 'Prime Video Content' && !isGenericTitle(metadata.title)) {
            bestKnownTitle = metadata.title;
          }
        }
      }

      if (metadata.title === 'Prime Video Content' && bestKnownTitle && !isGenericTitle(bestKnownTitle)) {
        metadata.title = bestKnownTitle;
      }

      if (metadata.title === 'Prime Video Content') {
        const ogTitle = document.querySelector('meta[property="og:title"]');
        const ogText = ogTitle?.getAttribute('content')?.trim();
        if (ogText && ogText.length > 1 && !isGenericTitle(ogText)) {
          const parsed = parsePrimeTitle(ogText);
          Object.assign(metadata, parsed);
          if (metadata.title !== 'Prime Video Content') {
            bestKnownTitle = metadata.title;
          }
        }
      }

      tryExtractPlayerTitle(metadata);
      metadata.thumbnailUrl = extractThumbnail();

      return metadata;
    }

    function tryExtractPlayerTitle(metadata: PrimeVideoMetadata): void {
      const titleSelectors = [
        '[data-testid="title-text"]',
        '[data-testid="video-title"]',
        '.atvwebplayersdk-title-text',
        '.dv-player-fullscreen .title',
        '.dv-dp-node-title',
        '.av-detail-section .dv-node-dp-title',
        'h1[data-automation-id="title"]'
      ];

      for (const selector of titleSelectors) {
        const el = document.querySelector(selector);
        const text = el?.textContent?.trim();
        if (text && text.length > 1 && !isGenericTitle(text)) {
          metadata.title = text;
          bestKnownTitle = text;
          log('[JP343] Prime Video: Player title found via', selector, ':', text);
          break;
        }
      }

      const subtitleSelectors = [
        '[data-testid="subtitle-text"]',
        '.atvwebplayersdk-subtitle-text',
        '.dv-player-fullscreen .subtitle'
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
            log('[JP343] Prime Video: Episode info found:', text);
            break;
          }
        }
      }
    }

    function parsePrimeTitle(rawTitle: string): Partial<PrimeVideoMetadata> {
      const result: Partial<PrimeVideoMetadata> = {
        title: rawTitle,
        isMovie: true
      };

      const sePattern = /^(.+?)\s*[-–]\s*S(\d+):?E(\d+)\s*[-–]?\s*(.*)$/i;
      let match = rawTitle.match(sePattern);
      if (match) {
        result.title = match[1].trim();
        result.seasonNumber = parseInt(match[2], 10);
        result.episodeNumber = parseInt(match[3], 10);
        result.episodeTitle = match[4].trim() || null;
        result.isMovie = false;
        return result;
      }

      const longPattern = /^(.+?)\s*[-–]\s*Season\s*(\d+).*Episode\s*(\d+)(.*)$/i;
      match = rawTitle.match(longPattern);
      if (match) {
        result.title = match[1].trim();
        result.seasonNumber = parseInt(match[2], 10);
        result.episodeNumber = parseInt(match[3], 10);
        result.episodeTitle = match[4].replace(/^[\s:–-]+/, '').trim() || null;
        result.isMovie = false;
        return result;
      }

      const dePattern = /^(.+?)\s*[-–]\s*Staffel\s*(\d+).*Folge\s*(\d+)(.*)$/i;
      match = rawTitle.match(dePattern);
      if (match) {
        result.title = match[1].trim();
        result.seasonNumber = parseInt(match[2], 10);
        result.episodeNumber = parseInt(match[3], 10);
        result.episodeTitle = match[4].replace(/^[\s:–-]+/, '').trim() || null;
        result.isMovie = false;
        return result;
      }

      const deShortPattern = /^(.+?)\s*[-–]\s*Staffel\s*(\d+).*?F\.\s*(\d+)(.*)$/i;
      match = rawTitle.match(deShortPattern);
      if (match) {
        result.title = match[1].trim();
        result.seasonNumber = parseInt(match[2], 10);
        result.episodeNumber = parseInt(match[3], 10);
        result.episodeTitle = match[4].replace(/^[\s:–-]+/, '').trim() || null;
        result.isMovie = false;
        return result;
      }

      const inlinePattern = /S(\d+)\s*E(\d+)/i;
      match = rawTitle.match(inlinePattern);
      if (match) {
        result.seasonNumber = parseInt(match[1], 10);
        result.episodeNumber = parseInt(match[2], 10);
        const titlePart = rawTitle.substring(0, rawTitle.indexOf(match[0])).trim();
        if (titlePart) {
          result.title = titlePart.replace(/[-–:]\s*$/, '').trim();
        }
        result.isMovie = false;
        return result;
      }

      const seasonOnly = parseSeasonOnly(rawTitle);
      if (seasonOnly) {
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
        [/S(\d+)\s*[:\s]?\s*E(\d+)/i, true],
        [/Season\s*(\d+).*Episode\s*(\d+)/i, true],
        [/Staffel\s*(\d+).*Folge\s*(\d+)/i, true],
        [/Staffel\s*(\d+).*?F\.?\s*(\d+)/i, true],
        [/(\d+)x(\d+)/, true],
        [/Ep\.?\s*(\d+)/i, false],
        [/\bF\.\s*(\d+)/, false],
        [/Folge\s*(\d+)/i, false],
        [/Episode\s*(\d+)/i, false]
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
          if (rest && rest.length > 2) {
            result.episodeTitle = rest;
          }
          break;
        }
      }

      return result;
    }

    function extractThumbnail(): string | null {
      const ogImage = document.querySelector('meta[property="og:image"]') as HTMLMetaElement;
      if (ogImage?.content && ogImage.content.includes('images-amazon.com') && !ogImage.content.includes('seo-logo')) {
        return ogImage.content;
      }
      return null;
    }

    function isAdPlaying(): boolean {
      if (!isWatchPage()) return false;

      const adSelectors = [
        '.atvwebplayersdk-ad-timer-remaining-time',
        '[data-testid="ad-timer"]',
        '[data-testid="ad-badge"]',
        '[data-testid="ad-info"]',
        '.atvwebplayersdk-ad-timer',
        '.adTimerText',
        '.adBreakTimer',
        '.atvwebplayersdk-adtimerdisplay',
        '[class*="adBreak"]',
        '[class*="ad-break"]',
        '[class*="adTimer"]'
      ];

      for (const selector of adSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          const rect = element.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            log('[JP343] Prime Video: Ad detected via:', selector);
            return true;
          }
        }
      }

      const allElements = document.querySelectorAll('span, div, p, [class*="ad"], [class*="Ad"]');
      for (const el of allElements) {
        const text = (el as HTMLElement).innerText?.trim();
        if (!text || text.length > 40) continue;
        if (/^(?:Werbung|Ad|Ads|Publicité|Anuncio|Pubblicità|Reclame|Annonce|広告|광고|Реклама)\s+\d/i.test(text)) {
          const isVisible = (el as HTMLElement).offsetParent !== null;
          if (isVisible) {
            log('[JP343] Prime Video: Ad detected via text:', text);
            return true;
          }
        }
      }

      const adClassElements = document.querySelectorAll('[class*="adBreak"], [class*="adTimer"], [class*="ad-timer"], [class*="adOverlay"], [class*="AdSlot"], [class*="ad-slot"]');
      for (const el of adClassElements) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          log('[JP343] Prime Video: Ad detected via class:', el.className);
          return true;
        }
      }

      return false;
    }

    function handleAdStateChange(): void {
      const adPlaying = isAdPlaying();

      if (adPlaying && !isCurrentlyInAd) {
        isCurrentlyInAd = true;
        log('[JP343] Prime Video: Ad started');
        sendMessage('AD_START');
      } else if (!adPlaying && isCurrentlyInAd) {
        isCurrentlyInAd = false;
        recentAdEnd = Date.now();
        log('[JP343] Prime Video: Ad ended');
        sendMessage('AD_END');
        setTimeout(() => {
          if (isCurrentlyInAd || isAdPlaying()) return;
          const v = findVideoElement();
          if (v && !v.paused && !v.ended) {
            const state = getCurrentVideoState();
            if (state) {
              log('[JP343] Prime Video: Resuming after ad');
              sendMessage('VIDEO_PLAY', { state });
            }
          }
        }, 1000);
      }
    }

    intervalIds.push(setInterval(handleAdStateChange, 500));

    intervalIds.push(setInterval(() => {
      if (isCurrentlyInAd || !isWatchPage() || !lastVideoId) return;
      const subtitle = document.querySelector('.atvwebplayersdk-subtitle-text');
      const text = subtitle?.textContent?.trim() || '';
      if (!text || text === lastSubtitleText) return;

      if (lastSubtitleText && Date.now() - lastEpisodeChangeTime > 15000) {
        lastEpisodeChangeTime = Date.now();
        episodeChangeCounter++;
        effectiveUrl = window.location.href + '#ep' + episodeChangeCounter;
        log('[JP343] Prime Video: Episode change #' + episodeChangeCounter + ' (subtitle: "' + lastSubtitleText + '" -> "' + text + '")');
        sendMessage('VIDEO_ENDED');
        bestKnownTitle = '';
        lastCurrentTime = 0;

        setTimeout(() => {
          if (isCurrentlyInAd || isAdPlaying()) return;
          const state = getCurrentVideoState();
          if (state) {
            lastTitle = state.title;
            log('[JP343] Prime Video: New episode started:', state.title);
            sendMessage('VIDEO_PLAY', { state });
          }
        }, 500);
      }

      lastSubtitleText = text;
    }, 3000));

    function getFormattedTitle(): string {
      const metadata = extractMetadata();

      if (metadata.isMovie) {
        return metadata.title;
      }

      let formatted = metadata.title;
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

    function getCurrentVideoState(): VideoState | null {
      const video = findVideoElement();
      if (!video) return null;

      const videoId = getVideoId();
      if (!videoId) return null;

      const metadata = extractMetadata();

      return {
        isPlaying: !video.paused && !video.ended,
        currentTime: video.currentTime,
        duration: video.duration || 0,
        title: getFormattedTitle(),
        url: effectiveUrl,
        platform: 'primevideo',
        isAd: isCurrentlyInAd || isAdPlaying(),
        thumbnailUrl: metadata.thumbnailUrl,
        videoId: videoId,
        channelId: (metadata.title !== 'Prime Video Content')
          ? 'primevideo:' + metadata.title : null,
        channelName: (metadata.title !== 'Prime Video Content')
          ? metadata.title : null,
        channelUrl: null
      };
    }

    async function sendMessage(type: string, data?: Record<string, unknown>): Promise<void> {
      try {
        await browser.runtime.sendMessage({
          type,
          platform: 'primevideo',
          ...data
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes('Extension context invalidated')) return;
        log('[JP343] Prime Video: Message error:', error);
      }
    }

    function attachVideoEvents(video: HTMLVideoElement): void {
      if (video.hasAttribute('data-jp343-tracked')) return;
      video.setAttribute('data-jp343-tracked', 'true');

      video.addEventListener('play', () => {
        debugLog('VIDEO_PLAY', '=== VIDEO PLAY EVENT ===', collectUIState());

        if (!isWatchPage()) {
          log('[JP343] Prime Video: Play on non-watch page ignored');
          return;
        }

        if (isAdPlaying() || isCurrentlyInAd) {
          debugLog('VIDEO_PLAY', 'Play during ad ignored', { isCurrentlyInAd, isAdPlaying: isAdPlaying() });
          log('[JP343] Prime Video: Play during ad ignored');
          if (!isCurrentlyInAd) {
            isCurrentlyInAd = true;
            sendMessage('AD_START');
          }
          return;
        }

        const videoId = getVideoId();

        if (videoId && lastVideoId && videoId === lastVideoId
            && video.currentTime < 15 && lastCurrentTime > 120
            && Date.now() - lastEpisodeChangeTime > 15000) {
          lastEpisodeChangeTime = Date.now();
          episodeChangeCounter++;
          effectiveUrl = window.location.href + '#ep' + episodeChangeCounter;
          log('[JP343] Prime Video: Episode change #' + episodeChangeCounter + ' (currentTime reset: ' + lastCurrentTime.toFixed(0) + 's -> ' + video.currentTime.toFixed(0) + 's)');
          sendMessage('VIDEO_ENDED');
          bestKnownTitle = '';
          lastCurrentTime = 0;
        }

        if (videoId && lastVideoId && videoId !== lastVideoId) {
          bestKnownTitle = '';
        }

        const state = getCurrentVideoState();
        if (state) {
          if (isGenericTitle(state.title)) {
            log('[JP343] Prime Video: Generic title - delaying...');
            let retryCount = 0;
            const titleRetry = setInterval(() => {
              retryCount++;
              const retryState = getCurrentVideoState();
              if (retryState && !isGenericTitle(retryState.title)) {
                clearInterval(titleRetry);
                lastVideoId = videoId;
                lastTitle = retryState.title;
                log('[JP343] Prime Video: Good title after retry #' + retryCount + ':', retryState.title);
                sendMessage('VIDEO_PLAY', { state: retryState });
              } else if (retryCount >= 5) {
                clearInterval(titleRetry);
                if (retryState && retryState.isPlaying && !isCurrentlyInAd) {
                  lastVideoId = videoId;
                  lastTitle = retryState.title;
                  sendMessage('VIDEO_PLAY', { state: retryState });
                }
              }
            }, 2000);
            return;
          }

          lastVideoId = videoId;
          lastTitle = state.title;
          lastCurrentTime = video.currentTime;
          log('[JP343] Prime Video Play:', state.title);
          sendMessage('VIDEO_PLAY', { state });
          sendDiagnostic('video_play_sent');
          sendDiagnostic(state.title ? 'metadata_found' : 'metadata_missing');
        }
      });

      video.addEventListener('pause', () => {
        debugLog('VIDEO_PAUSE', '=== VIDEO PAUSE EVENT ===', collectUIState());
        if (isCurrentlyInAd) return;
        sendMessage('VIDEO_PAUSE');
      });

      video.addEventListener('ended', () => {
        debugLog('VIDEO_ENDED', '=== VIDEO ENDED EVENT ===', collectUIState());
        if (isCurrentlyInAd) {
          log('[JP343] Prime Video: ended during ad ignored');
          return;
        }
        sendMessage('VIDEO_ENDED');
      });

      const updateInterval = setInterval(() => {
        if (isCurrentlyInAd || !isWatchPage()) return;

        const state = getCurrentVideoState();
        if (state && state.isPlaying) {
          const video = findVideoElement();
          if (video) lastCurrentTime = video.currentTime;

          const currentVideoId = getVideoId();

          if (currentVideoId && lastVideoId && currentVideoId !== lastVideoId) {
            log('[JP343] Prime Video: Video change:', lastVideoId, '->', currentVideoId);
            sendMessage('VIDEO_ENDED');
            bestKnownTitle = '';
            lastVideoId = currentVideoId;

            setTimeout(() => {
              const newState = getCurrentVideoState();
              if (newState && newState.isPlaying && !isCurrentlyInAd) {
                lastTitle = newState.title;
                sendMessage('VIDEO_PLAY', { state: newState });
              }
            }, 500);
          } else {
            if (state.title && state.title !== 'Prime Video Content') {
              lastTitle = state.title;
            }
            sendMessage('VIDEO_STATE_UPDATE', { state });
          }
        }
      }, 30000);
      intervalIds.push(updateInterval);

      log('[JP343] Prime Video: Events bound');
      sendDiagnostic('player_found');
    }

    const observer = new MutationObserver(() => {
      if (currentVideoElement && lastVideoId && !isPlayerActive()) {
        log('[JP343] Prime Video: Player closed - ending session');
        sendMessage('VIDEO_ENDED');
        currentVideoElement = null;
        bestKnownTitle = '';
        lastVideoId = null;
        lastTitle = '';
        return;
      }

      if (!isWatchPage()) return;

      const video = findVideoElement();
      if (video && video !== currentVideoElement) {
        currentVideoElement = video;
        attachVideoEvents(video);
        const videoId = getVideoId();

        if (!video.paused && !video.ended && videoId) {
          if (isAdPlaying() || isCurrentlyInAd) {
            log('[JP343] Prime Video: New video during ad');
            if (!isCurrentlyInAd) {
              isCurrentlyInAd = true;
              sendMessage('AD_START');
            }
          } else {
            log('[JP343] Prime Video: Video already playing');
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
              log('[JP343] Prime Video: Initial video playing');
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
        const wasOnWatch = oldUrl.includes('/detail/') || oldUrl.includes('/dp/') || oldUrl.includes('/gp/video/detail/');
        const isOnWatch = isWatchPage();

        debugLog('URL_CHANGE', '=== URL CHANGED ===', { oldUrl, newUrl, wasOnWatch, isOnWatch, ...collectUIState() });
        log('[JP343] Prime Video: URL change:', oldUrl, '->', newUrl);
        lastUrl = newUrl;
        effectiveUrl = newUrl;
        episodeChangeCounter = 0;
        lastEpisodeChangeTime = 0;
        lastCurrentTime = 0;

        if (wasOnWatch && !isOnWatch) {
          log('[JP343] Prime Video: Left watch page');
          sendMessage('VIDEO_ENDED');
          bestKnownTitle = '';
          return;
        }

        bestKnownTitle = '';

        if (isOnWatch) {
          setTimeout(() => {
            const video = findVideoElement();
            if (video && video !== currentVideoElement) {
              currentVideoElement = video;
              attachVideoEvents(video);
              lastVideoId = getVideoId();
              lastTitle = getFormattedTitle();
            }
          }, 1000);
        }
      }
    }, 1000));

    const titleElement = document.querySelector('title');
    if (titleElement) {
      const titleObserver = new MutationObserver(() => {
        const docTitle = document.title;
        if (docTitle && !isGenericTitle(docTitle)) {
          const cleanTitle = docTitle
            .replace(/\s*[\|–-]\s*(?:Prime Video|Amazon Prime Video|Amazon\.?\w*).*$/i, '')
            .replace(/^(?:Watch|Ansehen)\s+/i, '')
            .trim();
          if (cleanTitle && cleanTitle.length > 2 && !isGenericTitle(cleanTitle) && cleanTitle !== bestKnownTitle) {
            if (isWatchPage()) {
              log('[JP343] Prime Video: New title detected:', cleanTitle);
              bestKnownTitle = cleanTitle;
            }
          }
        }
      });
      titleObserver.observe(titleElement, { childList: true, characterData: true, subtree: true });
      observers.push(titleObserver);
    }

    setTimeout(() => {
      if (!isWatchPage()) return;
      const video = findVideoElement();
      const videoId = getVideoId();
      if (video && !video.paused && !video.ended && videoId && !isAdPlaying() && !isCurrentlyInAd) {
        const state = getCurrentVideoState();
        if (state && !isGenericTitle(state.title)) {
          log('[JP343] Prime Video: Starting delayed tracking');
          lastVideoId = videoId;
          lastTitle = state.title;
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
