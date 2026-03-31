import type { JP343UserState } from '../../types';

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
    const DEBUG_MODE = import.meta.env.DEV;
    const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};

    log('[JP343 Bridge] Content script loaded');

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
            extApiToken: userData.extApiToken || null
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
        extApiToken: null
      };
    }

    function getDisplayName(): string | null {
      const dataAttr = document.documentElement.getAttribute('data-jp343-user');
      if (!dataAttr) return null;
      try { return JSON.parse(dataAttr).displayName || null; } catch { return null; }
    }

    async function reportUserState(): Promise<void> {
      const userState = getUserState();
      try {
        await browser.runtime.sendMessage({
          type: 'JP343_SITE_LOADED',
          userState,
          displayName: getDisplayName()
        });
        log('[JP343 Bridge] User state reported:', userState.isLoggedIn ? 'logged in' : 'not logged in');
      } catch (_error) {
        // Extension context invalidated
      }
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
      }
      return true;
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
      } catch (_error) {
        // Extension context invalidated
      }
    }

    waitForUserStateAndReport();
    provideExtensionData();
  }
});
