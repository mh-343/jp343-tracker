import { isJapaneseContent } from '../../lib/language-detection';
import {
  VIDEO_CARD_SELECTORS, getCardTitleText, extractVideoIdFromElement,
  getChannelIdFromElement, getChannelNameFromElement, getChannelUrlFromElement,
  getChannelPageIdentity, isChannelInList, fetchOembedTitle
} from '../../lib/youtube-utils';
import type { WhitelistedChannel } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { claimContentScript } from '../../lib/content-guard';

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',

  main() {
    if (!claimContentScript('youtube-filter')) return;

    const observers: MutationObserver[] = [];
    // stale verdicts on recycled cards must not survive navigation
    const navHandler = () => {
      if (!filterEnabled) return;
      setTimeout(() => {
        if (!filterEnabled || contextLost()) return;
        clearProcessedMarks(true);
        scheduleUpdate();
      }, 200);
    };

    function stopAll() {
      clearRetry();
      document.removeEventListener('yt-navigate-finish', navHandler);
      window.removeEventListener('popstate', navHandler);
      observers.forEach(o => o.disconnect());
      observers.length = 0;
    }

    function cleanup() {
      stopAll();
      showAllVideos();
    }
    window.addEventListener('pagehide', cleanup);

    // Orphan must not touch the shared DOM
    function contextLost(): boolean {
      try {
        if (browser.runtime?.id) return false;
      } catch { /* context gone */ }
      stopAll();
      return true;
    }

    let filterEnabled = false;
    let whitelistedChannels: WhitelistedChannel[] = [];
    let pageChannelAllowlisted = false;
    let filterObserver: MutationObserver | null = null;
    let updateScheduled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    const RETRY_DELAYS = [300, 1000];

    const PROCESSED_ATTR = 'data-jp343-processed';
    const HIDDEN_CLASS = 'jp343-jp-hidden';

    const titleCache = new Map<string, Promise<string | null>>();

    function injectStyles(): void {
      if (document.getElementById('jp343-filter-styles')) return;
      const style = document.createElement('style');
      style.id = 'jp343-filter-styles';
      style.textContent = `.${HIDDEN_CLASS} { display: none !important; }`;
      document.head.appendChild(style);
    }

    function getOriginalTitle(videoId: string): Promise<string | null> {
      let pending = titleCache.get(videoId);
      if (!pending) {
        pending = fetchOembedTitle(videoId);
        titleCache.set(videoId, pending);
      }
      return pending;
    }

    function recomputePageChannel(): void {
      const identity = getChannelPageIdentity();
      pageChannelAllowlisted = !!identity
        && isChannelInList(whitelistedChannels, identity.channelId, identity.channelUrl);
    }

    async function processVideo(element: Element): Promise<void> {
      const prevStamp = element.getAttribute(PROCESSED_ATTR);
      const videoId = extractVideoIdFromElement(element);
      // stamp carries the videoId, rebind = re-check
      if (prevStamp && prevStamp === (videoId || '1')) return;
      if (!prevStamp && element.closest(`[${PROCESSED_ATTR}]`)) return;

      const domTitle = getCardTitleText(element);

      if (!domTitle && !videoId) return;

      element.setAttribute(PROCESSED_ATTR, videoId || '1');

      const htmlEl = element as HTMLElement;
      htmlEl.classList.remove(HIDDEN_CLASS);

      if (pageChannelAllowlisted) return;

      const channelId = getChannelIdFromElement(element);
      const channelUrl = getChannelUrlFromElement(element);
      if (channelId && isChannelInList(whitelistedChannels, channelId, channelUrl)) {
        return;
      }

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
        // card may have been rebound during the await
        if (element.getAttribute(PROCESSED_ATTR) !== videoId) return;
        if (originalTitle && isJapaneseContent(originalTitle)) {
          htmlEl.classList.remove(HIDDEN_CLASS);
          return;
        }
      }
    }

    function processAllVideos(): void {
      if (contextLost()) return;
      recomputePageChannel();
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
        if (contextLost()) return;
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
        if (contextLost()) return;
        processAllVideos();
        retryCount = 0;
        scheduleRetry();
      });
    }

    function clearProcessedMarks(visibleOnly = false): void {
      const processed = document.querySelectorAll(`[${PROCESSED_ATTR}]`);
      processed.forEach((el) => {
        // cached pages keep their frozen verdicts
        if (visibleOnly && el.closest('[hidden]')) return;
        el.removeAttribute(PROCESSED_ATTR);
      });
    }

    function showAllVideos(): void {
      const hidden = document.querySelectorAll(`.${HIDDEN_CLASS}`);
      hidden.forEach((el) => {
        el.classList.remove(HIDDEN_CLASS);
      });
      clearProcessedMarks();
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
