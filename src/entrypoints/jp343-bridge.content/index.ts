// =============================================================================
// JP343 Extension - Bridge Content Script
// Laeuft auf JP343-Seite und meldet User-State an Background
// Auto-Sync im Background uebernimmt den Rest
// =============================================================================

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

    log('[JP343 Bridge] Content Script geladen');

    // Signal fuer Website: Extension ist installiert
    const version = browser.runtime.getManifest().version;
    document.documentElement.setAttribute('data-jp343-extension', version);
    log('[JP343 Bridge] Extension v' + version + ' signalisiert');

    // Script injizieren das JP343_USER aus Page Context in data-Attribut schreibt
    // (Content Scripts haben isolierten Context und koennen window.JP343_USER nicht direkt lesen!)
    // Wichtig: Externes Script nutzen wegen CSP (inline Scripts werden blockiert!)
    function injectUserStateScript(): void {
      const script = document.createElement('script');
      script.src = browser.runtime.getURL('inject-user-state.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    }

    // Sofort beim Laden injizieren um User State zu extrahieren
    injectUserStateScript();

    // JP343_USER aus data-Attribut lesen (wurde von injiziertem Script gesetzt)
    function getUserState(): JP343UserState {
      const dataAttr = document.documentElement.getAttribute('data-jp343-user');
      if (dataAttr) {
        try {
          const userData = JSON.parse(dataAttr);

          // ajaxUrl validieren: muss auf jp343.com zeigen
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
                log('[JP343 Bridge] Ungueltige ajaxUrl ignoriert:', url.hostname);
              }
            } catch {
              log('[JP343 Bridge] ajaxUrl ist keine gueltige URL');
            }
          }

          return {
            isLoggedIn: userData.isLoggedIn || false,
            userId: userData.userId || null,
            nonce: userData.nonce || null,
            ajaxUrl: validatedAjaxUrl,
            guestToken: userData.guestToken || null,
            extApiToken: userData.extApiToken || null
          };
        } catch (e) {
          log('[JP343 Bridge] Fehler beim Parsen von data-jp343-user:', e);
        }
      }

      return {
        isLoggedIn: false,
        userId: null,
        nonce: null,
        ajaxUrl: null,
        guestToken: null,
        extApiToken: null
      };
    }

    // User State an Background melden (fuer Auto-Sync Auth)
    async function reportUserState(): Promise<void> {
      const userState = getUserState();
      try {
        await browser.runtime.sendMessage({
          type: 'JP343_SITE_LOADED',
          userState
        });
        log('[JP343 Bridge] User State gemeldet:', userState.isLoggedIn ? 'eingeloggt' : 'nicht eingeloggt');
      } catch (_error) {
        // Extension context ungueltig
      }
    }

    // Warten bis JP343_USER verfuegbar ist (Script braucht evtl. einen Moment)
    function waitForUserStateAndReport(maxWait = 5000): void {
      const startTime = Date.now();

      const check = () => {
        const userState = getUserState();

        if (userState.ajaxUrl || Date.now() - startTime > maxWait) {
          reportUserState();
          return;
        }

        // Script braucht evtl. noch einen Moment
        if (!document.documentElement.hasAttribute('data-jp343-user')) {
          injectUserStateScript();
        }
        setTimeout(check, 100);
      };

      setTimeout(check, 50);
    }

    // Message Handler fuer Background-Anfragen
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === 'JP343_GET_USER_STATE') {
        sendResponse(getUserState());
      }
      return true;
    });

    // Extension-Daten (Pending Entries + Stats) fuer die Website bereitstellen
    // Website kann diese ueber data-jp343-extension-data Attribut lesen
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
        log('[JP343 Bridge] Extension-Daten bereitgestellt:', entries.length, 'Entries');
      } catch (_error) {
        // Extension context ungueltig oder kein Background
      }
    }

    // User State melden (mit Warten auf Script-Injection)
    waitForUserStateAndReport();

    // Extension-Daten bereitstellen (fuer My Hub ohne Account)
    provideExtensionData();
  }
});
