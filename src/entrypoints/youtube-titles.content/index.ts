import { STORAGE_KEYS } from '../../types';
import {
  VIDEO_CARD_SELECTORS, CARD_TITLE_SELECTORS, WATCH_TITLE_SELECTORS,
  extractVideoIdFromUrl, extractVideoIdFromElement, fetchOembedTitle
} from '../../lib/youtube-utils';

interface CacheEntry {
  title: string;
  fetchedAt: number;
}

interface StoredCache {
  [videoId: string]: CacheEntry;
}

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',

  main() {
    const observers: MutationObserver[] = [];
    const timeoutIds: ReturnType<typeof setTimeout>[] = [];
    function cleanup() {
      observers.forEach(o => o.disconnect());
      observers.length = 0;
      timeoutIds.forEach(id => clearTimeout(id));
      timeoutIds.length = 0;
      restoreAllTitles();
      if (feedObserver) { feedObserver.disconnect(); feedObserver = null; }
      if (documentTitleObserver) { documentTitleObserver.disconnect(); documentTitleObserver = null; }
    }
    window.addEventListener('pagehide', cleanup);

    const DEBUG_MODE = import.meta.env.DEV;
    const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};

    const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
    const CACHE_MAX_ENTRIES = 1000;
    const CACHE_EVICT_COUNT = 100;
    const URL_CHANGE_DEBOUNCE_MS = 250;
    const BROWSING_DEBOUNCE_MS = 50;
    const CACHE_SAVE_DEBOUNCE_MS = 500;
    const REPLACED_ATTR = 'data-jp343-title-replaced';

    let enabled = false;
    let titleCache = new Map<string, CacheEntry>();
    let watchReplacedElements = new Map<Element, string>();
    let watchObservers = new Map<Element, MutationObserver>();
    let cardObservers = new Map<Element, MutationObserver>();
    let documentTitleObserver: MutationObserver | null = null;
    let documentTitleExpected: string | null = null;
    let originalDocumentTitle: string | null = null;
    let titleGuard = false;
    let feedObserver: MutationObserver | null = null;
    let urlChangeTimer: ReturnType<typeof setTimeout> | null = null;
    let browsingDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let cacheSaveTimer: ReturnType<typeof setTimeout> | null = null;
    let currentWatchVideoId: string | null = null;
    let pendingResolutions = new Map<string, Promise<string | null>>();

    // --- Persistent cache ---

    async function loadCacheFromStorage(): Promise<void> {
      try {
        const result = await browser.storage.local.get(STORAGE_KEYS.TITLE_CACHE);
        const stored: StoredCache = result[STORAGE_KEYS.TITLE_CACHE] ?? {};
        const now = Date.now();
        for (const [videoId, entry] of Object.entries(stored)) {
          if (entry && entry.title && now - entry.fetchedAt < CACHE_TTL_MS) {
            titleCache.set(videoId, entry);
          }
        }
        log('[JP343-titles] Cache loaded:', titleCache.size, 'entries');
      } catch {
        log('[JP343-titles] Failed to load cache');
      }
    }

    function scheduleCacheSave(): void {
      if (cacheSaveTimer) return;
      cacheSaveTimer = setTimeout(() => {
        cacheSaveTimer = null;
        saveCacheToStorage();
      }, CACHE_SAVE_DEBOUNCE_MS);
      timeoutIds.push(cacheSaveTimer);
    }

    async function saveCacheToStorage(): Promise<void> {
      try {
        const now = Date.now();
        const entries = Array.from(titleCache.entries())
          .filter(([, e]) => now - e.fetchedAt < CACHE_TTL_MS);

        if (entries.length > CACHE_MAX_ENTRIES) {
          entries.sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
          entries.splice(0, entries.length - CACHE_MAX_ENTRIES + CACHE_EVICT_COUNT);
        }

        const stored: StoredCache = {};
        for (const [videoId, entry] of entries) {
          stored[videoId] = entry;
        }

        titleCache = new Map(entries);
        await browser.storage.local.set({ [STORAGE_KEYS.TITLE_CACHE]: stored });
      } catch {
        log('[JP343-titles] Failed to save cache');
      }
    }

    // --- Title resolution ---

    function awaitPageEvent(eventName: string, videoId: string, timeoutMs: number): Promise<string | null> {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          window.removeEventListener(eventName, handler);
          resolve(null);
        }, timeoutMs);

        function handler(e: Event) {
          const detail = (e as CustomEvent).detail;
          if (detail?.videoId !== videoId) return;
          clearTimeout(timer);
          window.removeEventListener(eventName, handler);
          resolve(detail.title ?? null);
        }

        window.addEventListener(eventName, handler);
      });
    }

    function injectPageScript(filename: string): void {
      try {
        const script = document.createElement('script');
        script.src = browser.runtime.getURL(filename);
        document.documentElement.appendChild(script);
      } catch {
        log('[JP343-titles] Failed to inject', filename);
      }
    }

    async function resolveTitle(videoId: string, usePageScripts: boolean): Promise<string | null> {
      const cached = titleCache.get(videoId);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.title;
      }

      const dedupKey = `${videoId}:${usePageScripts}`;
      if (pendingResolutions.has(dedupKey)) {
        return pendingResolutions.get(dedupKey)!;
      }

      const promise = resolveTitleUncached(videoId, usePageScripts);
      pendingResolutions.set(dedupKey, promise);
      try {
        return await promise;
      } finally {
        pendingResolutions.delete(dedupKey);
      }
    }

    async function resolveTitleUncached(videoId: string, usePageScripts: boolean): Promise<string | null> {
      if (usePageScripts) {
        const playerPromise = awaitPageEvent('jp343-original-title', videoId, 1000);
        injectPageScript('inject-yt-original-title.js');
        const playerTitle = await playerPromise;
        if (playerTitle) {
          storeInCache(videoId, playerTitle);
          return playerTitle;
        }

        const innertubePromise = awaitPageEvent('jp343-innertube-title', videoId, 2500);
        injectPageScript('inject-yt-innertube-title.js');
        const innertubeTitle = await innertubePromise;
        if (innertubeTitle) {
          storeInCache(videoId, innertubeTitle);
          return innertubeTitle;
        }
      }

      const oembedTitle = await fetchOembedTitle(videoId);
      if (oembedTitle) {
        storeInCache(videoId, oembedTitle);
        return oembedTitle;
      }

      return null;
    }

    function storeInCache(videoId: string, title: string): void {
      titleCache.set(videoId, { title, fetchedAt: Date.now() });
      scheduleCacheSave();
    }

    // --- DOM helpers ---

    function setElementText(el: Element, text: string): void {
      if (el.children.length === 0) {
        el.textContent = text;
      } else {
        const textNode = findDeepTextNode(el);
        if (textNode) {
          textNode.textContent = text;
        } else {
          el.textContent = text;
        }
      }
    }

    function findDeepTextNode(el: Element): Text | null {
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
          return child as Text;
        }
        if (child.nodeType === Node.ELEMENT_NODE) {
          const found = findDeepTextNode(child as Element);
          if (found) return found;
        }
      }
      return null;
    }

    function removeObserver(obs: MutationObserver): void {
      obs.disconnect();
      const idx = observers.indexOf(obs);
      if (idx !== -1) observers.splice(idx, 1);
    }

    // --- Watch title replacement (stores original for restore) ---

    function replaceWatchElement(el: Element, newText: string): void {
      if (!watchReplacedElements.has(el)) {
        watchReplacedElements.set(el, el.textContent?.trim() ?? '');
      }

      if (el.textContent?.trim() === newText) return;

      const existingObs = watchObservers.get(el);
      if (existingObs) removeObserver(existingObs);

      setElementText(el, newText);

      const obs = new MutationObserver(() => {
        if (el.textContent?.trim() !== newText) {
          obs.disconnect();
          setElementText(el, newText);
          obs.observe(el, { characterData: true, childList: true, subtree: true });
        }
      });
      obs.observe(el, { characterData: true, childList: true, subtree: true });
      watchObservers.set(el, obs);
      observers.push(obs);
    }

    // --- Card title replacement (recycling-aware, no original storage) ---

    function replaceCardTitle(card: Element, titleEl: Element, videoId: string, newText: string): void {
      if (titleEl.textContent?.trim() === newText) {
        card.setAttribute(REPLACED_ATTR, videoId);
        return;
      }

      const existingObs = cardObservers.get(titleEl);
      if (existingObs) removeObserver(existingObs);

      setElementText(titleEl, newText);
      card.setAttribute(REPLACED_ATTR, videoId);

      const obs = new MutationObserver(() => {
        const currentVideoId = extractVideoIdFromElement(card);
        if (currentVideoId !== videoId) {
          removeObserver(obs);
          cardObservers.delete(titleEl);
          card.removeAttribute(REPLACED_ATTR);
          return;
        }
        if (titleEl.textContent?.trim() !== newText) {
          obs.disconnect();
          setElementText(titleEl, newText);
          obs.observe(titleEl, { characterData: true, childList: true, subtree: true });
        }
      });
      obs.observe(titleEl, { characterData: true, childList: true, subtree: true });
      cardObservers.set(titleEl, obs);
      observers.push(obs);
    }

    // --- Document title ---

    function replaceDocumentTitle(title: string): void {
      if (originalDocumentTitle === null) {
        originalDocumentTitle = document.title;
      }

      documentTitleExpected = `${title} - YouTube`;

      if (document.title !== documentTitleExpected) {
        titleGuard = true;
        document.title = documentTitleExpected;
        titleGuard = false;
      }

      if (documentTitleObserver) return;

      const titleEl = document.querySelector('title');
      if (!titleEl) return;

      documentTitleObserver = new MutationObserver(() => {
        if (titleGuard) return;
        if (!documentTitleExpected) return;
        if (document.title !== documentTitleExpected) {
          titleGuard = true;
          document.title = documentTitleExpected;
          titleGuard = false;
        }
      });
      documentTitleObserver.observe(titleEl, { characterData: true, childList: true, subtree: true });
      observers.push(documentTitleObserver);
    }

    function cleanupDocumentTitle(restore: boolean): void {
      if (documentTitleObserver) {
        removeObserver(documentTitleObserver);
        documentTitleObserver = null;
      }

      if (restore && originalDocumentTitle !== null) {
        titleGuard = true;
        document.title = originalDocumentTitle;
        titleGuard = false;
      }

      documentTitleExpected = null;
      originalDocumentTitle = null;
    }

    // --- Restore ---

    function restoreAllTitles(): void {
      for (const [el, originalText] of watchReplacedElements) {
        const obs = watchObservers.get(el);
        if (obs) removeObserver(obs);
        setElementText(el, originalText);
      }
      watchReplacedElements.clear();
      watchObservers.clear();

      for (const [, obs] of cardObservers) {
        removeObserver(obs);
      }
      cardObservers.clear();

      cleanupDocumentTitle(true);

      document.querySelectorAll(`[${REPLACED_ATTR}]`).forEach(el => {
        el.removeAttribute(REPLACED_ATTR);
      });
    }

    // --- Watch page ---

    async function replaceWatchTitle(videoId: string): Promise<void> {
      currentWatchVideoId = videoId;
      const title = await resolveTitle(videoId, true);
      if (!title) return;
      if (currentWatchVideoId !== videoId) return;

      log('[JP343-titles] Watch title resolved:', title);

      for (const selector of WATCH_TITLE_SELECTORS) {
        const el = document.querySelector(selector);
        if (el?.textContent?.trim()) {
          replaceWatchElement(el, title);
          break;
        }
      }

      replaceDocumentTitle(title);
    }

    // --- Browsing pages ---

    async function replaceBrowsingTitles(): Promise<void> {
      const cards = document.querySelectorAll(VIDEO_CARD_SELECTORS);

      for (const card of Array.from(cards)) {
        const existingId = card.getAttribute(REPLACED_ATTR);
        const videoId = extractVideoIdFromElement(card);
        if (!videoId) continue;
        if (existingId === videoId) continue;

        let titleEl: Element | null = null;
        for (const selector of CARD_TITLE_SELECTORS) {
          const el = card.querySelector(selector);
          if (el?.textContent?.trim()) {
            titleEl = el;
            break;
          }
        }
        if (!titleEl) continue;

        const cached = titleCache.get(videoId);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
          replaceCardTitle(card, titleEl, videoId, cached.title);
          continue;
        }

        const capturedTitleEl = titleEl;
        resolveTitle(videoId, false).then(title => {
          if (!title || !enabled) return;
          if (card.getAttribute(REPLACED_ATTR) === videoId) return;
          replaceCardTitle(card, capturedTitleEl, videoId, title);
        });
      }
    }

    function scheduleBrowsingRefresh(): void {
      if (browsingDebounceTimer) return;
      browsingDebounceTimer = setTimeout(() => {
        browsingDebounceTimer = null;
        if (enabled) replaceBrowsingTitles();
      }, BROWSING_DEBOUNCE_MS);
      timeoutIds.push(browsingDebounceTimer);
    }

    // --- Feed observer for infinite scroll ---

    function startFeedObserver(): void {
      if (feedObserver) return;
      feedObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of Array.from(mutation.addedNodes)) {
            if (!(node instanceof Element)) continue;
            if (node.matches(VIDEO_CARD_SELECTORS) || node.querySelector(VIDEO_CARD_SELECTORS)) {
              scheduleBrowsingRefresh();
              return;
            }
          }
        }
      });
      feedObserver.observe(document.body, { childList: true, subtree: true });
      observers.push(feedObserver);
    }

    function stopFeedObserver(): void {
      if (feedObserver) {
        removeObserver(feedObserver);
        feedObserver = null;
      }
    }

    // --- SPA navigation ---

    function handleUrlChange(): void {
      currentWatchVideoId = null;

      for (const [el, obs] of watchObservers) {
        removeObserver(obs);
        const origText = watchReplacedElements.get(el);
        if (origText !== undefined) setElementText(el, origText);
      }
      watchReplacedElements.clear();
      watchObservers.clear();

      for (const [, obs] of cardObservers) {
        removeObserver(obs);
      }
      cardObservers.clear();

      cleanupDocumentTitle(false);

      document.querySelectorAll(`[${REPLACED_ATTR}]`).forEach(el => {
        el.removeAttribute(REPLACED_ATTR);
      });

      if (!enabled) return;

      const path = window.location.pathname;
      const videoId = extractVideoIdFromUrl();

      if ((path.startsWith('/watch') || path.startsWith('/shorts/')) && videoId) {
        const delayTimer = setTimeout(() => replaceWatchTitle(videoId), 150);
        timeoutIds.push(delayTimer);
      }

      replaceBrowsingTitles();
      const t1 = setTimeout(() => { if (enabled) replaceBrowsingTitles(); }, 2000);
      const t2 = setTimeout(() => { if (enabled) replaceBrowsingTitles(); }, 5000);
      timeoutIds.push(t1, t2);
    }

    function scheduleUrlChange(): void {
      if (urlChangeTimer) clearTimeout(urlChangeTimer);
      urlChangeTimer = setTimeout(() => {
        urlChangeTimer = null;
        handleUrlChange();
      }, URL_CHANGE_DEBOUNCE_MS);
      timeoutIds.push(urlChangeTimer);
    }

    window.addEventListener('popstate', scheduleUrlChange);
    document.addEventListener('yt-navigate-finish', scheduleUrlChange);
    document.addEventListener('yt-page-data-updated', scheduleUrlChange);

    // --- Settings ---

    function onSettingsChanged(newEnabled: boolean): void {
      if (newEnabled === enabled) return;
      enabled = newEnabled;

      if (enabled) {
        log('[JP343-titles] Enabled');
        startFeedObserver();
        handleUrlChange();
      } else {
        log('[JP343-titles] Disabled');
        stopFeedObserver();
        restoreAllTitles();
      }
    }

    async function loadSettings(): Promise<void> {
      try {
        const response = await browser.runtime.sendMessage({ type: 'GET_SETTINGS' });
        if (response?.success && response.data?.settings) {
          onSettingsChanged(response.data.settings.useOriginalTitles ?? false);
        }
      } catch { /* context invalidated */ }
    }

    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[STORAGE_KEYS.SETTINGS]?.newValue) {
        onSettingsChanged(changes[STORAGE_KEYS.SETTINGS].newValue.useOriginalTitles ?? false);
      }
    });

    // --- Init ---

    loadCacheFromStorage().then(() => loadSettings());
  }
});
