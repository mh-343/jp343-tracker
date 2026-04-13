// JP343 Extension - YouTube Japanese Content Filter
// Hides non-Japanese videos from the YouTube feed, fetches original titles via oEmbed

import { isJapaneseContent } from '../../lib/language-detection';

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',

  main() {
    const observers: MutationObserver[] = [];
    function cleanup() {
      observers.forEach(o => o.disconnect());
      observers.length = 0;
      showAllVideos();
    }
    window.addEventListener('pagehide', cleanup);

    let filterEnabled = false;
    let filterObserver: MutationObserver | null = null;
    let updateScheduled = false;

    const VIDEO_SELECTORS = [
      'ytd-rich-item-renderer',
      'ytd-video-renderer',
      'ytd-compact-video-renderer',
      'ytd-grid-video-renderer',
      'ytd-reel-item-renderer',
      'yt-lockup-view-model',
      'ytd-playlist-video-renderer',
      'ytd-movie-renderer'
    ].join(',');

    const TITLE_SELECTORS = [
      '#video-title',
      '#video-title-link',
      'a#video-title',
      '#movie-title',
      'a.yt-lockup-metadata-view-model-wiz__title',
      'yt-formatted-string#video-title',
      'span.yt-core-attributed-string',
      'h3 a'
    ];

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

    function getVideoTitle(element: Element): string | null {
      for (const selector of TITLE_SELECTORS) {
        const titleEl = element.querySelector(selector);
        const text = titleEl?.textContent?.trim();
        if (text) return text;
      }
      return null;
    }

    function getVideoId(element: Element): string | null {
      const link = element.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
      if (!link) return null;

      const href = link.getAttribute('href');
      if (!href) return null;

      try {
        if (href.includes('/shorts/')) {
          const match = href.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
          return match ? match[1] : null;
        }
        const url = new URL(href, 'https://youtube.com');
        return url.searchParams.get('v');
      } catch {
        return null;
      }
    }

    async function getOriginalTitle(videoId: string): Promise<string | null> {
      if (titleCache.has(videoId)) {
        return titleCache.get(videoId) ?? null;
      }

      try {
        const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}`;
        const response = await fetch(url);
        if (!response.ok) {
          titleCache.set(videoId, null);
          return null;
        }
        const data = await response.json();
        const title = data.title?.trim() || null;
        titleCache.set(videoId, title);
        return title;
      } catch {
        titleCache.set(videoId, null);
        return null;
      }
    }

    async function processVideo(element: Element): Promise<void> {
      if (element.hasAttribute(PROCESSED_ATTR)) return;
      element.setAttribute(PROCESSED_ATTR, '1');

      const htmlEl = element as HTMLElement;
      htmlEl.classList.add(HIDDEN_CLASS);

      const domTitle = getVideoTitle(element);
      if (domTitle && isJapaneseContent(domTitle)) {
        htmlEl.classList.remove(HIDDEN_CLASS);
        return;
      }

      const videoId = getVideoId(element);
      if (videoId) {
        const originalTitle = await getOriginalTitle(videoId);
        if (originalTitle && isJapaneseContent(originalTitle)) {
          htmlEl.classList.remove(HIDDEN_CLASS);
          return;
        }
      }
    }

    function processAllVideos(): void {
      const videos = document.querySelectorAll(VIDEO_SELECTORS);
      videos.forEach((video) => {
        processVideo(video);
      });
    }

    function scheduleUpdate(): void {
      if (updateScheduled) return;
      updateScheduled = true;
      requestAnimationFrame(() => {
        updateScheduled = false;
        processAllVideos();
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

      filterObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of Array.from(mutation.addedNodes)) {
            if (!(node instanceof Element)) continue;
            if (node.hasAttribute(PROCESSED_ATTR)) continue;
            if (node.matches(VIDEO_SELECTORS) || node.querySelector(VIDEO_SELECTORS)) {
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
      if (filterObserver) {
        const idx = observers.indexOf(filterObserver);
        if (idx !== -1) observers.splice(idx, 1);
        filterObserver.disconnect();
        filterObserver = null;
      }
      showAllVideos();
    }

    async function loadSettings(): Promise<void> {
      try {
        const response = await browser.runtime.sendMessage({ type: 'GET_SETTINGS' });
        if (response?.success && response.data?.settings) {
          const enabled = response.data.settings.requireJapaneseContent ?? false;
          if (enabled !== filterEnabled) {
            filterEnabled = enabled;
            if (filterEnabled) {
              startFiltering();
            } else {
              stopFiltering();
            }
          }
        }
      } catch { /* ignore */ }
    }

    loadSettings();

    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.jp343_extension_settings?.newValue) {
        const enabled = changes.jp343_extension_settings.newValue.requireJapaneseContent ?? false;
        if (enabled !== filterEnabled) {
          filterEnabled = enabled;
          if (filterEnabled) {
            startFiltering();
          } else {
            stopFiltering();
          }
        }
      }
    });
  }
});
