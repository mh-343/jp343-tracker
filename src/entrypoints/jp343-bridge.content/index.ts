import type { JP343UserState } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { loadBackground } from '../../lib/background-image';
import { createDebugLogger } from '../../lib/debug-logger';

export default defineContentScript({
  matches: [
    '*://jp343.com/*',
    '*://*.jp343.com/*',
    ...(import.meta.env.DEV ? [
      '*://localhost/*',
      '*://127.0.0.1/*'
    ] : [])
  ],
  runAt: 'document_idle',

  main() {
    const { log } = createDebugLogger('jp343-bridge');

    log('[JP343 Bridge] Content script loaded');

    const observers: MutationObserver[] = [];
    const intervalIds: ReturnType<typeof setInterval>[] = [];
    const storageListeners: Array<(changes: Record<string, Browser.storage.StorageChange>, area: string) => void> = [];

    let disposed = false;

    function cleanup(): void {
      disposed = true;
      for (const o of observers) o.disconnect();
      observers.length = 0;
      for (const id of intervalIds) clearInterval(id);
      intervalIds.length = 0;
      for (const fn of storageListeners) {
        try { browser.storage.onChanged.removeListener(fn); } catch { /* ignore */ }
      }
      storageListeners.length = 0;
      if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl);
        currentObjectUrl = null;
      }
    }
    window.addEventListener('pagehide', cleanup);

    const version = browser.runtime.getManifest().version;
    document.documentElement.setAttribute('data-jp343-extension', version);
    log('[JP343 Bridge] Extension v' + version + ' signaled');

    function injectUserStateScript(): void {
      const script = document.createElement('script');
      script.src = browser.runtime.getURL('inject-user-state.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    }

    injectUserStateScript();

    function getUserState(): JP343UserState {
      const dataAttr = document.documentElement.getAttribute('data-jp343-user');
      if (dataAttr) {
        try {
          const userData = JSON.parse(dataAttr);

          let validatedAjaxUrl: string | null = null;
          if (userData.ajaxUrl) {
            try {
              const url = new URL(userData.ajaxUrl);
              const isJp343 = url.protocol === 'https:' &&
                (url.hostname === 'jp343.com' || url.hostname.endsWith('.jp343.com'));
              const isLocalDev = import.meta.env.DEV &&
                (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
              if (isJp343 || isLocalDev) {
                validatedAjaxUrl = userData.ajaxUrl;
              } else {
                log('[JP343 Bridge] Invalid ajaxUrl ignored:', url.hostname);
              }
            } catch {
              log('[JP343 Bridge] ajaxUrl is not a valid URL');
            }
          }

          return {
            isLoggedIn: userData.isLoggedIn || false,
            userId: userData.userId || null,
            nonce: userData.nonce || null,
            ajaxUrl: validatedAjaxUrl,
            extApiToken: userData.extApiToken || null,
            avatarUrlSmall: userData.avatarUrlSmall || null
          };
        } catch (e) {
          log('[JP343 Bridge] Failed to parse data-jp343-user:', e);
        }
      }

      return {
        isLoggedIn: false,
        userId: null,
        nonce: null,
        ajaxUrl: null,
        extApiToken: null,
        avatarUrlSmall: null
      };
    }

    function getDisplayName(): string | null {
      const dataAttr = document.documentElement.getAttribute('data-jp343-user');
      if (!dataAttr) return null;
      try { return JSON.parse(dataAttr).displayName || null; } catch { return null; }
    }

    let extTokenCached = false;

    function isSameOrigin(url: string): boolean {
      try { return new URL(url).origin === location.origin; } catch { return false; }
    }

    async function fetchExtToken(ajaxUrl: string, nonce: string): Promise<string | null> {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        let response: Response;
        try {
          response = await fetch(ajaxUrl, {
            method: 'POST',
            credentials: 'include',
            signal: controller.signal,
            body: new URLSearchParams({
              action: 'jp343_extension_get_token',
              nonce,
              ext_version: browser.runtime.getManifest().version
            })
          });
        } finally {
          clearTimeout(timeout);
        }
        if (!response.ok) return null;
        const result: { success?: boolean; data?: { extApiToken?: string } } = await response.json();
        return result?.success && result.data?.extApiToken ? result.data.extApiToken : null;
      } catch (error) {
        if (error instanceof Error && error.message.includes('Extension context invalidated')) return null;
        log('[JP343 Bridge] get_token error:', error);
        return null;
      }
    }

    async function reportUserState(): Promise<void> {
      const userState = getUserState();
      if (
        !extTokenCached &&
        userState.isLoggedIn &&
        userState.nonce &&
        userState.ajaxUrl &&
        !userState.extApiToken &&
        isSameOrigin(userState.ajaxUrl)
      ) {
        const token = await fetchExtToken(userState.ajaxUrl, userState.nonce);
        if (token) {
          userState.extApiToken = token;
          extTokenCached = true;
        }
      }
      try {
        await browser.runtime.sendMessage({
          type: 'JP343_SITE_LOADED',
          userState,
          displayName: getDisplayName()
        });
        log('[JP343 Bridge] User state reported:', userState.isLoggedIn ? 'logged in' : 'not logged in');
      } catch (_error) { /* ignore */ }
    }

    function waitForUserStateAndReport(maxWait = 5000): void {
      const startTime = Date.now();

      const check = () => {
        const userState = getUserState();

        if (userState.ajaxUrl || Date.now() - startTime > maxWait) {
          reportUserState();
          return;
        }

        if (!document.documentElement.hasAttribute('data-jp343-user')) {
          injectUserStateScript();
        }
        setTimeout(check, 100);
      };

      setTimeout(check, 50);
    }

    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === 'JP343_GET_USER_STATE') {
        sendResponse(getUserState());
        return true;
      }
      return undefined;
    });

    async function provideExtensionData(): Promise<void> {
      try {
        const [entriesResponse, statsResponse] = await Promise.all([
          browser.runtime.sendMessage({ type: 'GET_PENDING_ENTRIES' }),
          browser.runtime.sendMessage({ type: 'GET_STATS' })
        ]);

        const entries = entriesResponse?.entries || [];
        const stats = statsResponse || {};

        const data = JSON.stringify({ entries, stats });
        document.documentElement.setAttribute('data-jp343-extension-data', data);
        log('[JP343 Bridge] Extension data provided:', entries.length, 'entries');
      } catch (_error) { /* ignore */ }
    }

    waitForUserStateAndReport();

    let lastUserAttr = document.documentElement.getAttribute('data-jp343-user');
    const userAttrObserver = new MutationObserver(() => {
      const current = document.documentElement.getAttribute('data-jp343-user');
      if (current && current !== lastUserAttr) {
        lastUserAttr = current;
        reportUserState();
      }
    });
    userAttrObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-jp343-user']
    });
    observers.push(userAttrObserver);

    function provideExtensionDataIfLoggedIn(): void {
      const maxWait = 6000;
      const start = Date.now();
      const poll = () => {
        const state = getUserState();
        if (state.isLoggedIn) {
          provideExtensionData();
          return;
        }
        if (Date.now() - start < maxWait && !document.documentElement.hasAttribute('data-jp343-user')) {
          setTimeout(poll, 200);
          return;
        }
        log('[JP343 Bridge] Not logged in, extension data not exposed');
      };
      setTimeout(poll, 300);
    }
    provideExtensionDataIfLoggedIn();

    let currentObjectUrl: string | null = null;
    let bgSyncGeneration = 0;
    let lastWantBg: boolean | null = null;

    async function syncHubBackgroundLayer(): Promise<void> {
      if (disposed) return;
      const thisGeneration = ++bgSyncGeneration;
      bodyClassObserver.disconnect();
      try {
        const wantBg = document.body?.classList.contains('jp343-hub-bg-enabled') ?? false;
        lastWantBg = wantBg;
        const layer = document.querySelector<HTMLDivElement>('.jp343-ext-bg-layer');
        const overlay = document.querySelector<HTMLDivElement>('.jp343-ext-bg-overlay');

        if (!wantBg) {
          document.body.classList.remove('jp343-hub-bg-active');
          layer?.remove();
          overlay?.remove();
          if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }
          return;
        }

        const blob = await loadBackground();
        if (thisGeneration !== bgSyncGeneration || disposed) return;

        if (!blob) {
          document.body.classList.remove('jp343-hub-bg-active');
          layer?.remove();
          overlay?.remove();
          return;
        }

        if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
        currentObjectUrl = URL.createObjectURL(blob);

        const settingsRes = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
        if (thisGeneration !== bgSyncGeneration || disposed) return;
        const opacity = (settingsRes[STORAGE_KEYS.SETTINGS]?.backgroundOpacity ?? 75) / 100;

        const ensuredLayer = layer ?? (() => {
          const el = document.createElement('div');
          el.className = 'jp343-ext-bg-layer';
          document.body.prepend(el);
          return el;
        })();
        ensuredLayer.style.backgroundImage = `url(${currentObjectUrl})`;

        const ensuredOverlay = overlay ?? (() => {
          const el = document.createElement('div');
          el.className = 'jp343-ext-bg-overlay';
          ensuredLayer.after(el);
          return el;
        })();
        ensuredOverlay.style.opacity = String(opacity);
        document.body.classList.add('jp343-hub-bg-active');
      } finally {
        if (!disposed && document.body) {
          bodyClassObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        }
      }
    }

    const bodyClassObserver = new MutationObserver(() => {
      const wantBg = document.body?.classList.contains('jp343-hub-bg-enabled') ?? false;
      if (wantBg === lastWantBg) return;
      syncHubBackgroundLayer();
    });
    function startBgObserver(): void {
      if (!document.body) return;
      bodyClassObserver.disconnect();
      bodyClassObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      if (!observers.includes(bodyClassObserver)) observers.push(bodyClassObserver);
      syncHubBackgroundLayer();
    }

    if (document.body) startBgObserver();
    else document.addEventListener('DOMContentLoaded', startBgObserver, { once: true });

    function onStorageChanged(changes: Record<string, Browser.storage.StorageChange>, area: string): void {
      if (area !== 'local') return;
      if (changes[STORAGE_KEYS.BG_IMAGE_REVISION] || changes[STORAGE_KEYS.SETTINGS]) {
        syncHubBackgroundLayer();
      }
    }
    browser.storage.onChanged.addListener(onStorageChanged);
    storageListeners.push(onStorageChanged);

    window.addEventListener('pageshow', (event) => {
      if (event.persisted) {
        disposed = false;
        startBgObserver();
        browser.storage.onChanged.addListener(onStorageChanged);
        storageListeners.push(onStorageChanged);
      }
    });
  }
});
