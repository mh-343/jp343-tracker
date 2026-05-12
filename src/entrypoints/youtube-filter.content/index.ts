import { isJapaneseContent } from '../../lib/language-detection';
import {
  VIDEO_CARD_SELECTORS, getCardTitleText, extractVideoIdFromElement,
  getChannelIdFromElement, getChannelNameFromElement, fetchOembedTitle
} from '../../lib/youtube-utils';
import type { WhitelistedChannel } from '../../types';
import { STORAGE_KEYS } from '../../types';

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',

  main() {
    const observers: MutationObserver[] = [];
    const navHandler = () => { if (filterEnabled) setTimeout(scheduleUpdate, 200); };

    function cleanup() {
      clearRetry();
      document.removeEventListener('yt-navigate-finish', navHandler);
      window.removeEventListener('popstate', navHandler);
      observers.forEach(o => o.disconnect());
      observers.length = 0;
      showAllVideos();
    }
    window.addEventListener('pagehide', cleanup);

    let filterEnabled = false;
    let whitelistedChannels: WhitelistedChannel[] = [];
    let filterObserver: MutationObserver | null = null;
    let updateScheduled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    const RETRY_DELAYS = [300, 1000];

    const PROCESSED_ATTR = 'data-jp343-processed';
    const HIDDEN_CLASS = 'jp343-jp-hidden';

    const titleCache = new Map<string, string | null>();

    function injectStyles(): void {
      if (document.getElementById('jp343-filter-styles')) return;
      const style = document.createElement('style');
      style.id = 'jp343-filter-styles';
      style.textContent = `.${HIDDEN_CLASS} { display: none !important; }`;
      document.head.appendChild(style);
    }

    async function getOriginalTitle(videoId: string): Promise<string | null> {
      if (titleCache.has(videoId)) return titleCache.get(videoId) ?? null;
      const title = await fetchOembedTitle(videoId);
      titleCache.set(videoId, title);
      return title;
    }

    async function processVideo(element: Element): Promise<void> {
      if (element.hasAttribute(PROCESSED_ATTR)) return;
      if (element.closest(`[${PROCESSED_ATTR}]`)) return;

      const domTitle = getCardTitleText(element);
      const videoId = extractVideoIdFromElement(element);

      if (!domTitle && !videoId) return;

      element.setAttribute(PROCESSED_ATTR, '1');

      const channelId = getChannelIdFromElement(element);
      if (channelId && whitelistedChannels.some(c => c.channelId === channelId)) {
        return;
      }

      const htmlEl = element as HTMLElement;
      htmlEl.classList.add(HIDDEN_CLASS);

      if (domTitle && isJapaneseContent(domTitle)) {
        htmlEl.classList.remove(HIDDEN_CLASS);
        return;
      }

      const channelName = getChannelNameFromElement(element);
      if (channelName && isJapaneseContent(channelName)) {
        htmlEl.classList.remove(HIDDEN_CLASS);
        return;
      }

      if (videoId) {
        const originalTitle = await getOriginalTitle(videoId);
        if (originalTitle && isJapaneseContent(originalTitle)) {
          htmlEl.classList.remove(HIDDEN_CLASS);
          return;
        }
      }
    }

    function processAllVideos(): void {
      const videos = document.querySelectorAll(VIDEO_CARD_SELECTORS);
      videos.forEach((video) => {
        processVideo(video);
      });
    }

    function clearRetry(): void {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    }

    function scheduleRetry(): void {
      clearRetry();
      if (retryCount >= RETRY_DELAYS.length) { retryCount = 0; return; }
      const delay = RETRY_DELAYS[retryCount];
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!filterEnabled) return;
        retryCount++;
        processAllVideos();
        scheduleRetry();
      }, delay);
    }

    function scheduleUpdate(): void {
      if (updateScheduled) return;
      updateScheduled = true;
      requestAnimationFrame(() => {
        updateScheduled = false;
        processAllVideos();
        retryCount = 0;
        scheduleRetry();
      });
    }

    function showAllVideos(): void {
      const hidden = document.querySelectorAll(`.${HIDDEN_CLASS}`);
      hidden.forEach((el) => {
        el.classList.remove(HIDDEN_CLASS);
      });
      const processed = document.querySelectorAll(`[${PROCESSED_ATTR}]`);
      processed.forEach((el) => {
        el.removeAttribute(PROCESSED_ATTR);
      });
    }

    function startFiltering(): void {
      if (filterObserver) return;

      injectStyles();
      processAllVideos();
      retryCount = 0;
      scheduleRetry();

      filterObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of Array.from(mutation.addedNodes)) {
            if (!(node instanceof Element)) continue;
            if (node.hasAttribute(PROCESSED_ATTR)) continue;
            if (node.matches(VIDEO_CARD_SELECTORS) || node.querySelector(VIDEO_CARD_SELECTORS)) {
              scheduleUpdate();
              return;
            }
          }
        }
      });

      filterObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
      observers.push(filterObserver);
    }

    function stopFiltering(): void {
      clearRetry();
      if (filterObserver) {
        const idx = observers.indexOf(filterObserver);
        if (idx !== -1) observers.splice(idx, 1);
        filterObserver.disconnect();
        filterObserver = null;
      }
      showAllVideos();
    }

    function applySettings(shouldFilter: boolean, channels: WhitelistedChannel[]): void {
      const whitelistChanged = JSON.stringify(channels) !== JSON.stringify(whitelistedChannels);
      whitelistedChannels = channels;
      if (shouldFilter !== filterEnabled) {
        filterEnabled = shouldFilter;
        if (filterEnabled) {
          startFiltering();
        } else {
          stopFiltering();
        }
      } else if (filterEnabled && whitelistChanged) {
        showAllVideos();
        processAllVideos();
      }
    }

    async function loadSettings(): Promise<void> {
      try {
        const response = await browser.runtime.sendMessage({ type: 'GET_SETTINGS' });
        if (response?.success && response.data?.settings) {
          const hide = response.data.settings.hideNonJapanese ?? false;
          const channels = response.data.settings.whitelistedChannels ?? [];
          applySettings(hide, channels);
        }
      } catch { /* ignore */ }
    }

    loadSettings();

    document.addEventListener('yt-navigate-finish', navHandler);
    window.addEventListener('popstate', navHandler);

    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[STORAGE_KEYS.SETTINGS]?.newValue) {
        const hide = changes[STORAGE_KEYS.SETTINGS].newValue.hideNonJapanese ?? false;
        const channels = changes[STORAGE_KEYS.SETTINGS].newValue.whitelistedChannels ?? [];
        applySettings(hide, channels);
      }
    });
  }
});
