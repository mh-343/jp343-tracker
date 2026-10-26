import type { DebugLogger } from '../../lib/debug-logger';
import { extractVideoIdFromUrl } from '../../lib/youtube-utils';

export function collectUIState(isCurrentlyAd: boolean, extensionContextValid: boolean): Record<string, unknown> {
  const video = document.querySelector('video.html5-main-video') as HTMLVideoElement | null;
  const player = document.querySelector('#movie_player') as HTMLElement | null;

  const adSelectors: Record<string, string> = {
    'ytp-ad-player-overlay': '.ytp-ad-player-overlay',
    'ytp-ad-player-overlay-instream-info': '.ytp-ad-player-overlay-instream-info',
    'ytp-ad-text': '.ytp-ad-text',
    'ytp-ad-skip-button': '.ytp-ad-skip-button',
    'ytp-ad-skip-button-container': '.ytp-ad-skip-button-container',
    'ad-showing': '.ad-showing',
    'ytp-ad-preview-container': '.ytp-ad-preview-container',
    'ad-interrupting': '[class*="ad-interrupting"]'
  };

  const adSelectorResults: Record<string, boolean> = {};
  for (const [name, selector] of Object.entries(adSelectors)) {
    adSelectorResults[name] = !!document.querySelector(selector);
  }

  const adTextElements = document.querySelectorAll('.ytp-ad-text, .ytp-ad-preview-text, .ytp-ad-skip-button-text');
  const adTexts: string[] = [];
  adTextElements.forEach(el => {
    if (el.textContent?.trim()) {
      adTexts.push(el.textContent.trim());
    }
  });

  const adClassElements = Array.from(document.querySelectorAll('[class*="ytp-ad"], [class*="ad-"]'))
    .slice(0, 20)
    .map(el => ({
      tag: el.tagName,
      classes: el.className,
      id: el.id || null,
      visible: (el as HTMLElement).offsetParent !== null,
      text: el.textContent?.trim()?.slice(0, 50) || null
    }));

  return {
    videoExists: !!video,
    videoPaused: video?.paused ?? null,
    videoEnded: video?.ended ?? null,
    videoDuration: video?.duration ?? null,
    videoCurrentTime: video?.currentTime ?? null,
    playerExists: !!player,
    playerClasses: player?.className || null,
    playerHasAdShowing: player?.classList.contains('ad-showing') ?? false,
    url: window.location.href,
    videoIdFromUrl: extractVideoIdFromUrl(),
    adSelectors: adSelectorResults,
    adTexts: adTexts,
    adClassElements: adClassElements,
    isCurrentlyAd: isCurrentlyAd,
    extensionContextValid: extensionContextValid
  };
}

export function startAdDebugObserver(debugLog: DebugLogger['debugLog']): MutationObserver {
  let lastPlayerAdShowing = false;

  const domObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) {
          const classes = node.className || '';
          const id = node.id || '';

          const isAdRelated =
            /ytp-ad|ad-showing|ad-interrupting|ad-overlay/i.test(classes) ||
            /ytp-ad|ad-showing/i.test(id);

          if (isAdRelated) {
            debugLog('DOM_ADD', 'New ad element added', {
              tag: node.tagName,
              classes: classes,
              id: id,
              innerText: node.innerText?.slice(0, 100),
              visible: node.offsetParent !== null
            });
          }
        }
      });

      mutation.removedNodes.forEach((node) => {
        if (node instanceof HTMLElement) {
          const classes = node.className || '';
          const id = node.id || '';

          const isAdRelated =
            /ytp-ad|ad-showing|ad-interrupting|ad-overlay/i.test(classes) ||
            /ytp-ad|ad-showing/i.test(id);

          if (isAdRelated) {
            debugLog('DOM_REMOVE', 'Ad element removed', {
              tag: node.tagName,
              classes: classes,
              id: id
            });
          }
        }
      });

      if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
        const target = mutation.target as HTMLElement;
        if (target.id === 'movie_player') {
          const hasAdShowing = target.classList.contains('ad-showing');
          if (hasAdShowing !== lastPlayerAdShowing) {
            lastPlayerAdShowing = hasAdShowing;
            debugLog('DOM_ATTR', hasAdShowing ? 'ad-showing ACTIVATED' : 'ad-showing REMOVED', {
              tag: target.tagName,
              id: target.id,
              hasAdShowing: hasAdShowing
            });
          }
        }
      }
    });
  });

  domObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });
  debugLog('INIT', 'Debug Mutation Observer started');
  return domObserver;
}
