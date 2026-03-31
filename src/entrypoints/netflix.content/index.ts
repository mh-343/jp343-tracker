// JP343 Extension - Netflix Content Script

import type { VideoState } from '../../types';
import { createDebugLogger, setupDebugCommands, DEBUG_MODE } from '../../lib/debug-logger';

interface NetflixMetadata {
  title: string;
  episodeTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  isMovie: boolean;
  thumbnailUrl: string | null;
}

export default defineContentScript({
  matches: ['*://*.netflix.com/*'],
  runAt: 'document_idle',

  main() {
    let currentVideoElement: HTMLVideoElement | null = null;
    let lastTitle: string = '';
    let lastVideoId: string | null = null;
    let cachedMetadata: NetflixMetadata | null = null;
    let bestKnownTitle: string = '';
    let isCurrentlyInAd: boolean = false;
    let pendingVideoId: string | null = null;

    const observers: MutationObserver[] = [];
    const intervalIds: ReturnType<typeof setInterval>[] = [];
    function cleanup(): void {
      observers.forEach(o => o.disconnect());
      intervalIds.forEach(clearInterval);
      observers.length = 0;
      intervalIds.length = 0;
    }
    window.addEventListener('pagehide', cleanup);

    let cachedPlayerTitle: { series: string; episode: string | null; episodeTitle: string | null } | null = null;

    let cachedBrowseThumbnail: string | null = null;

    const logger = createDebugLogger('netflix');
    const { log, debugLog } = logger;
    log('[JP343] Netflix Content Script loaded');
    setupDebugCommands(logger, 'netflix');

    function collectUIState(): Record<string, unknown> {
      const video = document.querySelector('video') as HTMLVideoElement | null;
      return {
        videoExists: !!video,
        videoPaused: video?.paused ?? null,
        videoEnded: video?.ended ?? null,
        videoDuration: video?.duration ?? null,
        videoCurrentTime: video?.currentTime ?? null,
        url: window.location.href,
        videoIdFromUrl: window.location.pathname.match(/\/watch\/(\d+)/)?.[1] || null,
        documentTitle: document.title,
        nextEpisodeBtn: !!document.querySelector('[data-uia="next-episode-seamless-button"]'),
        nextEpisodeDraining: !!document.querySelector('[data-uia="next-episode-seamless-button-draining"]'),
        skipPreplay: !!document.querySelector('.watch-video--skip-preplay-button'),
        skipContent: !!document.querySelector('.watch-video--skip-content-button'),
        skipIntro: !!document.querySelector('[aria-label="Skip Intro"], [data-uia="player-skip-intro"]'),
        skipRecap: !!document.querySelector('[aria-label="Skip Recap"], [data-uia="player-skip-recap"]'),
        adDataUiaElements: Array.from(document.querySelectorAll('[data-uia*="ad"]')).map(el => ({
          tag: el.tagName,
          dataUia: el.getAttribute('data-uia'),
          classes: el.className,
          visible: (el as HTMLElement).offsetParent !== null
        })),
        allVisibleDataUia: Array.from(document.querySelectorAll('[data-uia]'))
          .filter(el => (el as HTMLElement).offsetParent !== null)
          .slice(0, 20)
          .map(el => el.getAttribute('data-uia')),
        bodyClasses: document.body.className,
        playerClasses: document.querySelector('.watch-video, .AkiraPlayer')?.className || null,
        interstitialElements: Array.from(document.querySelectorAll('[class*="interstitial"], [class*="Interstitial"]')).map(el => ({
          tag: el.tagName,
          classes: el.className,
          visible: (el as HTMLElement).offsetParent !== null
        })),
        isCurrentlyInAd: isCurrentlyInAd,
        pendingVideoId: pendingVideoId,
        lastVideoId: lastVideoId,
        bestKnownTitle: bestKnownTitle
      };
    }

    if (DEBUG_MODE) {
      const debugMutationObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          mutation.addedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              const dataUia = node.getAttribute?.('data-uia');
              const classes = node.className || '';
              const ariaLabel = node.getAttribute?.('aria-label');

              const innerText = node.innerText?.slice(0, 50) || '';
              const isInteresting =
                dataUia ||
                /ad|skip|interstitial|preplay|next-episode|seamless|overlay|countdown/i.test(classes) ||
                /ad|skip/i.test(ariaLabel || '') ||
                /^Werbung\s+\d|^Ad\s+\d/i.test(innerText);

              if (isInteresting) {
                debugLog('DOM_ADD', 'New element added', {
                  tag: node.tagName,
                  dataUia: dataUia,
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
              const dataUia = node.getAttribute?.('data-uia');
              if (dataUia && /ad|skip|interstitial|next-episode/i.test(dataUia)) {
                debugLog('DOM_REMOVE', 'Element removed', {
                  tag: node.tagName,
                  dataUia: dataUia
                });
              }
            }
          });
        });
      });

      debugMutationObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
      observers.push(debugMutationObserver);

      debugLog('INIT', 'Debug Mutation Observer started');
    }

    function tryExtractPlayerTitle(): void {
      const titleContainer = document.querySelector('[data-uia="video-title"]');
      if (!titleContainer) return;

      const h4 = titleContainer.querySelector('h4');
      const spans = titleContainer.querySelectorAll('span');

      if (h4?.textContent?.trim()) {
        const series = h4.textContent.trim();
        const episode = spans[0]?.textContent?.trim() || null;
        const episodeTitle = spans[1]?.textContent?.trim() || null;

        if (series.length > 1) {
          cachedPlayerTitle = { series, episode, episodeTitle };
          log('[JP343] Netflix Player title cached (series):', series, episode, episodeTitle);
        }
      } else {
        const text = titleContainer.textContent?.trim();
        if (text && text.length > 1 && !isGenericPageTitle(text)) {
          cachedPlayerTitle = { series: text, episode: null, episodeTitle: null };
          log('[JP343] Netflix Player title cached (movie):', text);
        }
      }
    }

    intervalIds.push(setInterval(tryExtractPlayerTitle, 2000));

    function tryExtractBrowseThumbnail(): void {
      if (window.location.pathname.includes('/watch/')) return;

      const modal = document.querySelector('.previewModal--container, [data-uia="previewModal--container"]');
      if (!modal) return;

      const storyArt = modal.querySelector('.storyArt img, .storyArt') as HTMLElement;
      if (storyArt) {
        if (storyArt instanceof HTMLImageElement && storyArt.src) {
          cachedBrowseThumbnail = storyArt.src;
          log('[JP343] Netflix Browse thumbnail cached (storyArt img)');
          return;
        }
        const bg = window.getComputedStyle(storyArt).backgroundImage;
        const urlMatch = bg.match(/url\(["']?([^"')]+)["']?\)/);
        if (urlMatch?.[1]) {
          cachedBrowseThumbnail = urlMatch[1];
          log('[JP343] Netflix Browse thumbnail cached (storyArt bg)');
          return;
        }
      }

      const imgs = modal.querySelectorAll('img[src*="nflxso.net"], img[src*="nflximg"]');
      for (const img of imgs) {
        const src = (img as HTMLImageElement).src;
        if (src && !src.includes('transparent') && !src.includes('logo')) {
          cachedBrowseThumbnail = src;
          log('[JP343] Netflix Browse thumbnail cached (boxart)');
          return;
        }
      }

      const heroImg = document.querySelector('.billboard-row img, [data-uia="billboard"] img') as HTMLImageElement;
      if (heroImg?.src && !heroImg.src.includes('transparent')) {
        cachedBrowseThumbnail = heroImg.src;
        log('[JP343] Netflix Browse thumbnail cached (billboard)');
      }
    }

    const modalObserver = new MutationObserver(() => {
      tryExtractBrowseThumbnail();
    });
    modalObserver.observe(document.body, { childList: true, subtree: true });
    observers.push(modalObserver);

    const GENERIC_TITLES = new Set([
      'netflix', 'home', 'startseite', 'browse',
      'filme', 'serien', 'meine liste', 'neu und beliebt', 'kategorien',
      'movies', 'tv shows', 'my list', 'new & popular', 'categories',
      'trending now', 'top 10'
    ]);
    function isGenericPageTitle(title: string): boolean {
      if (!title || title === 'Netflix Content') return true;
      const lower = title.toLowerCase().trim();
      if (lower.length < 2) return true;
      if (lower.includes('netflix home') || lower.includes('browse')) return true;
      return GENERIC_TITLES.has(lower);
    }

    function findVideoElement(): HTMLVideoElement | null {
      return document.querySelector('video') as HTMLVideoElement;
    }

    function isAdPlaying(): boolean {
      if (!window.location.pathname.includes('/watch/')) {
        return false;
      }

      const adIndicators = [
        '[data-uia="ads-info-container"]',
        '[data-uia="ads-info-text"]',
        '.watch-video--adsInfo-container',
        '[data-uia="video-ad"]',
        '[data-uia="ad-skip"]',
        '[data-uia="player-skip-ad"]',
        '.skip-ad',
        '[data-uia="ad-progress"]',
        '.ad-countdown',
        '.ad-progress-bar',
        '.watch-video--ad-playing',
        '.AkiraPlayer--ad-interstitial',
        '[data-uia="interstitial-container"]',
        '.interstitial-text',
        '.interstitial-container',
        '[class*="adBreak"]',
        '[class*="ad-break"]',
        '.watch-video--modular-ads-container'
      ];

      for (const selector of adIndicators) {
        const element = document.querySelector(selector);
        if (element) {
          const rect = element.getBoundingClientRect();
          const isVisible = rect.width > 0 && rect.height > 0;
          if (isVisible) {
            log('[JP343] Netflix Ad detected via:', selector);
            return true;
          }
        }
      }

      const body = document.body;
      const player = document.querySelector('.watch-video, .AkiraPlayer, [data-uia="watch-video"]');
      const adClasses = ['ad-playing', 'ad-interstitial', 'interstitial', 'ad-mode'];

      for (const className of adClasses) {
        if (body.classList.contains(className) || player?.classList.contains(className)) {
          log('[JP343] Netflix Ad detected via class:', className);
          return true;
        }
      }

      const playerArea = document.querySelector('.watch-video, .AkiraPlayer, [data-uia="watch-video"]') || document.body;
      const textElements = playerArea.querySelectorAll('span, div, p');
      for (const el of textElements) {
        const text = (el as HTMLElement).innerText?.trim();
        if (!text || text.length > 30) continue;
        if (/^(?:Werbung|Ad|Publicité|Anuncio|Pubblicità|Reclame|Annonce|広告|광고|Реклама)\s+\d/i.test(text)) {
          const isVisible = (el as HTMLElement).offsetParent !== null;
          if (isVisible) {
            log('[JP343] Netflix Ad detected via text:', text);
            return true;
          }
        }
      }

      const video = findVideoElement();
      if (video && video.duration > 0 && video.duration < 45 && pendingVideoId) {
        log('[JP343] Netflix: Short video detected (', Math.round(video.duration), 's)');
        return true;
      }

      return false;
    }

    function startSessionWithTitleRetry(videoId: string): void {
      setTimeout(() => {
        clearMetadataCache();
        const state = getCurrentVideoState();
        if (!state || !state.isPlaying || isAdPlaying() || isCurrentlyInAd) return;

        if (isGenericPageTitle(state.title) && !cachedPlayerTitle) {
          log('[JP343] Netflix: Title still generic after ad - starting retry...');
          let retryCount = 0;
          const titleRetry = setInterval(() => {
            retryCount++;
            clearMetadataCache();
            const retryState = getCurrentVideoState();
            if (retryState && !isGenericPageTitle(retryState.title)) {
              clearInterval(titleRetry);
              lastVideoId = videoId;
              lastTitle = retryState.title;
              log('[JP343] Netflix: Good title after ad retry #' + retryCount + ':', retryState.title);
              sendMessage('VIDEO_PLAY', { state: retryState });
            } else if (retryCount >= 5) {
              clearInterval(titleRetry);
              if (retryState && retryState.isPlaying && !isCurrentlyInAd) {
                lastVideoId = videoId;
                lastTitle = retryState.title;
                log('[JP343] Netflix: Starting after ad timeout with title:', retryState.title);
                sendMessage('VIDEO_PLAY', { state: retryState });
              }
            }
          }, 2000);
        } else {
          lastVideoId = videoId;
          lastTitle = state.title;
          log('[JP343] Netflix: Session started after ad:', state.title);
          sendMessage('VIDEO_PLAY', { state });
        }
      }, 500);
    }

    function handleAdStateChange(): void {
      const adPlaying = isAdPlaying();

      if (adPlaying && !isCurrentlyInAd) {
        isCurrentlyInAd = true;
        debugLog('AD_STATE', '=== AD STARTED ===', collectUIState());
        log('[JP343] Netflix: Ad started');
        sendMessage('AD_START');
      } else if (!adPlaying && isCurrentlyInAd) {
        isCurrentlyInAd = false;
        debugLog('AD_STATE', '=== AD ENDED ===', collectUIState());
        log('[JP343] Netflix: Ad ended');
        sendMessage('AD_END');

        if (pendingVideoId) {
          const savedVideoId = pendingVideoId;
          debugLog('AD_STATE', 'Starting saved session', { pendingVideoId: savedVideoId });
          log('[JP343] Netflix: Starting saved session after ad ended');
          pendingVideoId = null;
          startSessionWithTitleRetry(savedVideoId);
        }
      }
    }

    intervalIds.push(setInterval(handleAdStateChange, 500));

    if (DEBUG_MODE) {
      intervalIds.push(setInterval(() => {
        const video = findVideoElement();
        if (video && !video.paused) {
          debugLog('PERIODIC', 'Periodic state check', collectUIState());
        }
      }, 5000));
    }

    function extractNetflixMetadata(): NetflixMetadata {
      const metadata: NetflixMetadata = {
        title: 'Netflix Content',
        episodeTitle: null,
        seasonNumber: null,
        episodeNumber: null,
        isMovie: true,
        thumbnailUrl: null
      };

      const docTitle = document.title;
      if (!isGenericPageTitle(docTitle)) {
        const cleanTitle = docTitle
          .replace(/\s*[\|–-]\s*Netflix.*$/i, '')
          .replace(/\s*-\s*Watch.*$/i, '')
          .trim();
        if (cleanTitle && cleanTitle.length > 0 && cleanTitle.toLowerCase() !== 'netflix') {
          const parsed = parseNetflixTitle(cleanTitle);
          Object.assign(metadata, parsed);
          if (metadata.title !== 'Netflix Content' && !isGenericPageTitle(metadata.title)) {
            bestKnownTitle = metadata.title;
          }
        }
      }

      if (metadata.title === 'Netflix Content' && bestKnownTitle && !isGenericPageTitle(bestKnownTitle)) {
        metadata.title = bestKnownTitle;
      }

      tryExtractPlayerTitle();

      if (cachedPlayerTitle) {
        metadata.title = cachedPlayerTitle.series;
        if (cachedPlayerTitle.episode) {
          metadata.isMovie = false;
        }
        bestKnownTitle = cachedPlayerTitle.series;

        if (cachedPlayerTitle.episode) {
          const epParsed = parseEpisodeInfo(cachedPlayerTitle.episode);
          if (epParsed.episodeNumber) {
            metadata.episodeNumber = epParsed.episodeNumber;
            if (epParsed.seasonNumber) metadata.seasonNumber = epParsed.seasonNumber;
          }
        }
        if (cachedPlayerTitle.episodeTitle) {
          metadata.episodeTitle = cachedPlayerTitle.episodeTitle;
        }
      }

      if (!metadata.episodeNumber) {
        const episodeInfoSelectors = [
          '[data-uia="video-title"] + span',
          '.video-title span:not(.title)',
          '.ellipsize-text + .ellipsize-text'
        ];

        for (const selector of episodeInfoSelectors) {
          const element = document.querySelector(selector);
          if (element?.textContent?.trim()) {
            const episodeInfo = parseEpisodeInfo(element.textContent.trim());
            if (episodeInfo.seasonNumber || episodeInfo.episodeNumber) {
              metadata.seasonNumber = episodeInfo.seasonNumber;
              metadata.episodeNumber = episodeInfo.episodeNumber;
              metadata.episodeTitle = episodeInfo.episodeTitle;
              metadata.isMovie = false;
              break;
            }
          }
        }
      }

      metadata.thumbnailUrl = extractThumbnail();

      return metadata;
    }

    function parseNetflixTitle(rawTitle: string): Partial<NetflixMetadata> {
      const result: Partial<NetflixMetadata> = {
        title: rawTitle,
        isMovie: true
      };

      const colonPattern = /^(.+?):\s*S(\d+):E(\d+)\s*(.*)$/i;
      let match = rawTitle.match(colonPattern);
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

      const flgPattern = /^(.+?)\s+Flg\.\s*(\d+)\s+(.+)$/i;
      match = rawTitle.match(flgPattern);
      if (match) {
        result.title = match[1].trim();
        result.episodeNumber = parseInt(match[2], 10);
        result.episodeTitle = match[3].trim();
        result.isMovie = false;
        return result;
      }

      const flgShortPattern = /^(.+?)\s+Flg\.\s*(\d+)$/i;
      match = rawTitle.match(flgShortPattern);
      if (match) {
        result.title = match[1].trim();
        result.episodeNumber = parseInt(match[2], 10);
        result.isMovie = false;
        return result;
      }

      const folgePattern = /^(.+?)\s+Folge\s*(\d+)\s+(.+)$/i;
      match = rawTitle.match(folgePattern);
      if (match) {
        result.title = match[1].trim();
        result.episodeNumber = parseInt(match[2], 10);
        result.episodeTitle = match[3].trim();
        result.isMovie = false;
        return result;
      }

      const epPattern = /^(.+?)\s+(?:Ep\.?|Episode)\s*(\d+)\s+(.+)$/i;
      match = rawTitle.match(epPattern);
      if (match) {
        result.title = match[1].trim();
        result.episodeNumber = parseInt(match[2], 10);
        result.episodeTitle = match[3].trim();
        result.isMovie = false;
        return result;
      }

      return result;
    }

    function parseEpisodeInfo(text: string): { seasonNumber: number | null; episodeNumber: number | null; episodeTitle: string | null } {
      const result = { seasonNumber: null as number | null, episodeNumber: null as number | null, episodeTitle: null as string | null };

      const patterns = [
        /S(\d+):?E(\d+)/i,
        /Season\s*(\d+).*Episode\s*(\d+)/i,
        /Staffel\s*(\d+).*Folge\s*(\d+)/i,
        /(\d+)x(\d+)/,
        /Flg\.\s*(\d+)/i,
        /Folge\s*(\d+)/i,
        /Ep\.?\s*(\d+)/i
      ];

      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          if (match[2]) {
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
      const miniPreview = document.querySelector('.mini-preview-player img') as HTMLImageElement;
      if (miniPreview?.src) {
        return miniPreview.src;
      }

      const billboardSelectors = [
        '.billboard-row img',
        '.jawbone-title-link img',
        '.title-card img',
        '.bob-card img',
        '[data-uia="billboard"] img'
      ];

      for (const selector of billboardSelectors) {
        const img = document.querySelector(selector) as HTMLImageElement;
        if (img?.src && !img.src.includes('transparent')) {
          return img.src;
        }
      }

      const bgSelectors = [
        '.billboard-row .billboard-image',
        '.hero-image-wrapper'
      ];

      for (const selector of bgSelectors) {
        const el = document.querySelector(selector) as HTMLElement;
        if (el) {
          const bg = window.getComputedStyle(el).backgroundImage;
          const urlMatch = bg.match(/url\(["']?([^"')]+)["']?\)/);
          if (urlMatch && urlMatch[1]) {
            return urlMatch[1];
          }
        }
      }

      if (cachedBrowseThumbnail) {
        log('[JP343] Netflix: Using cached browse thumbnail');
        return cachedBrowseThumbnail;
      }

      const ogImageSecure = document.querySelector('meta[property="og:image:secure_url"]') as HTMLMetaElement;
      const ogImage = document.querySelector('meta[property="og:image"]') as HTMLMetaElement;
      const metaThumb = ogImageSecure?.content || ogImage?.content;
      if (metaThumb && metaThumb.startsWith('https://') && !metaThumb.includes('nflx-static')) {
        log('[JP343] Netflix: OG image found from meta tag:', metaThumb);
        return metaThumb;
      }

      return null;
    }

    function getFormattedTitle(): string {
      const metadata = extractNetflixMetadata();
      cachedMetadata = metadata;

      if (metadata.isMovie) {
        return metadata.title;
      }

      let formatted = metadata.title;
      if (metadata.seasonNumber && metadata.episodeNumber) {
        formatted += ` S${metadata.seasonNumber}E${metadata.episodeNumber}`;
      } else if (metadata.episodeNumber) {
        formatted += ` E${metadata.episodeNumber}`;
      }
      if (metadata.episodeTitle) {
        formatted += `: ${metadata.episodeTitle}`;
      }
      return formatted;
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

      const metadata = cachedMetadata || extractNetflixMetadata();

      return {
        isPlaying: !video.paused && !video.ended,
        currentTime: video.currentTime,
        duration: video.duration || 0,
        title: getFormattedTitle(),
        url: window.location.href,
        platform: 'netflix',
        isAd: isCurrentlyInAd || isAdPlaying(),
        thumbnailUrl: metadata.thumbnailUrl,
        videoId: videoId,
        channelId: (metadata.title !== 'Netflix Content') ? 'netflix:' + metadata.title : null,
        channelName: (metadata.title !== 'Netflix Content') ? metadata.title : null,
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
        if (error instanceof Error && error.message.includes('Extension context invalidated')) return;
        log('[JP343] Message error:', error);
      }
    }

    function clearMetadataCache(): void {
      cachedMetadata = null;
      cachedPlayerTitle = null;
      if (bestKnownTitle && isGenericPageTitle(bestKnownTitle)) {
        log('[JP343] Netflix: Generic bestKnownTitle cleared:', bestKnownTitle);
        bestKnownTitle = '';
      }
    }

    function resetForNewVideo(): void {
      cachedMetadata = null;
      cachedPlayerTitle = null;
      if (bestKnownTitle) {
        log('[JP343] Netflix: bestKnownTitle reset on video change (was:', bestKnownTitle + ')');
        bestKnownTitle = '';
      }
    }

    function attachVideoEvents(video: HTMLVideoElement): void {
      if (video.hasAttribute('data-jp343-tracked')) {
        return;
      }
      video.setAttribute('data-jp343-tracked', 'true');

      video.addEventListener('play', () => {
        if (!window.location.pathname.includes('/watch/')) {
          log('[JP343] Netflix: Play event on non-watch page ignored');
          return;
        }

        debugLog('VIDEO_PLAY', '=== VIDEO PLAY EVENT ===', collectUIState());

        const videoId = getVideoId();
        if (videoId && lastVideoId && videoId !== lastVideoId) {
          resetForNewVideo();
        } else {
          clearMetadataCache();
        }

        if (isAdPlaying() || isCurrentlyInAd) {
          debugLog('VIDEO_PLAY', 'Play during ad - ignored', { videoId, isCurrentlyInAd, isAdPlaying: isAdPlaying() });
          log('[JP343] Netflix Play during ad - ignored, Video ID saved:', videoId);
          pendingVideoId = videoId;
          if (!isCurrentlyInAd) {
            isCurrentlyInAd = true;
            sendMessage('AD_START');
          }
          return;
        }

        const state = getCurrentVideoState();
        if (state) {
          if (isGenericPageTitle(state.title) && !cachedPlayerTitle && !bestKnownTitle) {
            debugLog('VIDEO_PLAY', 'Generic title detected - delaying tracking', { title: state.title, videoId });
            log('[JP343] Netflix: Generic title "' + state.title + '" - waiting for better title...');
            pendingVideoId = videoId;
            let retryCount = 0;
            const titleRetry = setInterval(() => {
              retryCount++;
              clearMetadataCache();
              const retryState = getCurrentVideoState();
              if (retryState && !isGenericPageTitle(retryState.title)) {
                clearInterval(titleRetry);
                lastVideoId = videoId;
                lastTitle = retryState.title;
                pendingVideoId = null;
                log('[JP343] Netflix: Good title found after retry #' + retryCount + ':', retryState.title);
                sendMessage('VIDEO_PLAY', { state: retryState });
              } else if (retryCount >= 5) {
                clearInterval(titleRetry);
                if (retryState && retryState.isPlaying && !isCurrentlyInAd) {
                  lastVideoId = videoId;
                  lastTitle = retryState.title;
                  pendingVideoId = null;
                  log('[JP343] Netflix: Starting tracking after timeout with title:', retryState.title);
                  sendMessage('VIDEO_PLAY', { state: retryState });
                }
              }
            }, 2000);
            return;
          }
          lastVideoId = videoId;
          lastTitle = state.title;
          debugLog('VIDEO_PLAY', 'Tracking started', { videoId, title: state.title });
          log('[JP343] Netflix Play:', state.title, '(ID:', lastVideoId, ')');
          sendMessage('VIDEO_PLAY', { state });
        }
      });

      video.addEventListener('pause', () => {
        debugLog('VIDEO_PAUSE', '=== VIDEO PAUSE EVENT ===', collectUIState());
        sendMessage('VIDEO_PAUSE');
      });

      video.addEventListener('ended', () => {
        debugLog('VIDEO_ENDED', '=== VIDEO ENDED EVENT ===', collectUIState());

        if (isCurrentlyInAd) {
          debugLog('VIDEO_ENDED', 'Ended during ad - ignored', { isCurrentlyInAd });
          log('[JP343] Netflix Video ended during ad - ignored');
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

      let quickUpdateCount = 0;
      const quickTitleUpdate = setInterval(() => {
        quickUpdateCount++;
        if (isCurrentlyInAd || video.paused) return;
        const state = getCurrentVideoState();
        if (state && state.isPlaying && !isGenericPageTitle(state.title) && state.title !== lastTitle) {
          log('[JP343] Netflix: Title update (quick #' + quickUpdateCount + '):', state.title);
          lastTitle = state.title;
          sendMessage('VIDEO_STATE_UPDATE', { state });
        }
        if (quickUpdateCount >= 6) clearInterval(quickTitleUpdate);
      }, 5000);

      setInterval(() => {
        if (isCurrentlyInAd || !window.location.pathname.includes('/watch/')) {
          return;
        }

        const state = getCurrentVideoState();
        if (state && state.isPlaying) {
          const currentVideoId = getVideoId();

          if (currentVideoId && lastVideoId && currentVideoId !== lastVideoId) {
            log('[JP343] Netflix Video change (ID):', lastVideoId, '->', currentVideoId);
            lastVideoId = currentVideoId;
            lastTitle = state.title;
            resetForNewVideo();
            sendMessage('VIDEO_ENDED');
            setTimeout(() => {
              const newState = getCurrentVideoState();
              if (newState && newState.isPlaying && !isCurrentlyInAd) {
                sendMessage('VIDEO_PLAY', { state: newState });
              }
            }, 500);
          } else {
            if (state.title && state.title !== 'Netflix Content') {
              lastTitle = state.title;
            }
            sendMessage('VIDEO_STATE_UPDATE', { state });
          }
        }
      }, 30000);

      log('[JP343] Netflix Video events bound');
    }

    const observer = new MutationObserver(() => {
      if (!window.location.pathname.includes('/watch/')) return;

      const video = findVideoElement();

      if (video && video !== currentVideoElement) {
        currentVideoElement = video;
        clearMetadataCache();
        attachVideoEvents(video);
        const videoId = getVideoId();

        if (!video.paused && !video.ended && videoId) {
          if (isAdPlaying() || isCurrentlyInAd) {
            debugLog('OBSERVER', 'New video during ad', { videoId });
            log('[JP343] Netflix: New video during ad detected, ID saved:', videoId);
            pendingVideoId = videoId;
            if (!isCurrentlyInAd) {
              isCurrentlyInAd = true;
              sendMessage('AD_START');
            }
          } else {
            log('[JP343] Netflix: New video already playing');
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

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
    observers.push(observer);

    const initialVideo = window.location.pathname.includes('/watch/') ? findVideoElement() : null;
    if (initialVideo) {
      currentVideoElement = initialVideo;
      attachVideoEvents(initialVideo);
      const videoId = getVideoId();

      if (!initialVideo.paused && !initialVideo.ended && videoId) {
        if (isAdPlaying()) {
          log('[JP343] Netflix: Video already playing during ad');
          isCurrentlyInAd = true;
          pendingVideoId = videoId;
          sendMessage('AD_START');
        } else {
          log('[JP343] Netflix: Video already playing, starting tracking');
          lastVideoId = videoId;
          lastTitle = getFormattedTitle();
          const state = getCurrentVideoState();
          if (state) {
            sendMessage('VIDEO_PLAY', { state });
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
        log('[JP343] Netflix URL change:', oldUrl, '->', newUrl);
        lastUrl = newUrl;

        if (wasOnWatch && !isOnWatch) {
          log('[JP343] Netflix: Left /watch/ - ending session');
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
              lastTitle = getFormattedTitle();
            }
          }, 1000);
        }
      }

    }, 1000));

    const titleObserver = new MutationObserver(() => {
      const docTitle = document.title;
      if (docTitle && docTitle.toLowerCase() !== 'netflix' && !docTitle.toLowerCase().includes('home')) {
        const cleanTitle = docTitle.replace(/\s*[\|–-]\s*Netflix.*$/i, '').trim();
        if (cleanTitle && cleanTitle.length > 2 && !isGenericPageTitle(cleanTitle)) {
          if (cleanTitle !== bestKnownTitle) {
            if (window.location.pathname.includes('/watch/')) {
              log('[JP343] Netflix: New title detected:', cleanTitle);
              bestKnownTitle = cleanTitle;
              clearMetadataCache();
            } else {
              log('[JP343] Netflix: Title on browse page ignored:', cleanTitle);
            }
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
      if (docTitle && docTitle.toLowerCase() !== 'netflix') {
        const cleanTitle = docTitle.replace(/\s*[\|–-]\s*Netflix.*$/i, '').trim();
        if (cleanTitle && cleanTitle.length > 2 && !isGenericPageTitle(cleanTitle) && cleanTitle !== bestKnownTitle) {
          if (window.location.pathname.includes('/watch/')) {
            log('[JP343] Netflix: Title found (check #' + titleCheckCount + '):', cleanTitle);
            bestKnownTitle = cleanTitle;
            clearMetadataCache();
          }
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
      const metadata = extractNetflixMetadata();
      const adPlaying = isAdPlaying();
      log('[JP343] Netflix Debug:', {
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
        if (state && !isGenericPageTitle(state.title)) {
          log('[JP343] Netflix: Starting delayed tracking');
          lastVideoId = videoId;
          lastTitle = state.title;
          sendMessage('VIDEO_PLAY', { state });
        }
      } else if (video && !video.paused && (adPlaying || isCurrentlyInAd) && videoId) {
        log('[JP343] Netflix: Video playing during ad - tracking paused');
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
