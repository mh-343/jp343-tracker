// JP343 Extension - Bridge Content Script

import type {
  PendingEntry,
  JP343ImmersionLogEntry,
  JP343UserState,
  Platform
} from '../../types';

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

    function cloneForPage<T>(obj: T): T {
      if (typeof (globalThis as any).cloneInto === 'function') {
        return (globalThis as any).cloneInto(obj, window);
      }
      return obj;
    }

    const version = browser.runtime.getManifest().version;
    document.documentElement.setAttribute('data-jp343-extension', version);
    log('[JP343 Bridge] Extension v' + version + ' signalisiert');

    function injectUserStateScript(): void {
      const script = document.createElement('script');
      script.src = browser.runtime.getURL('inject-user-state.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    }

    injectUserStateScript();

    const STORAGE_KEYS = {
      IMMERSION_LOG: 'jp343_immersion_log'
    };

    let extensionContextValid = true;
    let syncIntervalId: ReturnType<typeof setInterval> | null = null;

    // Cleanup-Registry (Fix 4+5)
    const intervalIds: ReturnType<typeof setInterval>[] = [];
    function cleanup(): void {
      intervalIds.forEach(clearInterval);
      intervalIds.length = 0;
      if (syncIntervalId) {
        clearInterval(syncIntervalId);
        syncIntervalId = null;
      }
    }
    window.addEventListener('pagehide', cleanup);

    function isExtensionContextValid(): boolean {
      try {
        return extensionContextValid && !!browser.runtime?.id;
      } catch {
        return false;
      }
    }

    function invalidateExtensionContext(): void {
      if (extensionContextValid) {
        log('[JP343 Bridge] Extension Context ungueltig - stoppe Sync');
        extensionContextValid = false;
        if (syncIntervalId) {
          clearInterval(syncIntervalId);
          syncIntervalId = null;
        }
      }
    }

    function waitForJP343User(maxWait = 5000): Promise<JP343UserState> {
      return new Promise((resolve) => {
        const startTime = Date.now();

        if (!document.documentElement.hasAttribute('data-jp343-user')) {
          injectUserStateScript();
        }

        const check = () => {
          const userState = getUserState();

          if (userState.ajaxUrl || Date.now() - startTime > maxWait) {
            log('[JP343 Bridge] User State:', userState.isLoggedIn ? 'eingeloggt' : userState.guestToken ? 'Gast mit Token' : 'Gast');
            resolve(userState);
            return;
          }

          setTimeout(check, 100);
        };

        setTimeout(check, 50);
      });
    }

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
            guestToken: userData.guestToken || null
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
        guestToken: null
      };
    }

    function getActivityType(platform: Platform): 'watching' | 'reading' | 'listening' | 'other' {
      const watchingPlatforms: Platform[] = ['youtube', 'netflix', 'crunchyroll'];
      return watchingPlatforms.includes(platform) ? 'watching' : 'other';
    }

    function convertToJP343Format(entry: PendingEntry): JP343ImmersionLogEntry {
      return {
        id: entry.id,
        date: entry.date,
        duration_min: entry.duration_min,
        project: entry.project,
        project_id: entry.project_id,
        source: 'extension',
        note: `Tracked via extension on ${entry.platform}`,
        resourceUrl: entry.url,
        thumbnail: entry.thumbnail,
        type: getActivityType(entry.platform),
        sessionId: entry.id,
        channelId: entry.channelId,
        channelName: entry.channelName,
        channelUrl: entry.channelUrl
      };
    }

    function entryExists(immersionLog: JP343ImmersionLogEntry[], entryId: string): boolean {
      return immersionLog.some(e => e.id === entryId || e.sessionId === entryId);
    }

    function injectEntry(entry: JP343ImmersionLogEntry): boolean {
      try {
        const logData = localStorage.getItem(STORAGE_KEYS.IMMERSION_LOG);
        const immersionLog: JP343ImmersionLogEntry[] = logData ? JSON.parse(logData) : [];

        if (entryExists(immersionLog, entry.id)) {
          log('[JP343 Bridge] Entry existiert bereits:', entry.id);
          return true;
        }

        immersionLog.push(entry);
        localStorage.setItem(STORAGE_KEYS.IMMERSION_LOG, JSON.stringify(immersionLog));

        window.dispatchEvent(new CustomEvent('jp343:tracker:changed', {
          detail: cloneForPage({ entry, action: 'log_added', source: 'extension' })
        }));

        log('[JP343 Bridge] Entry injiziert:', entry.project, entry.duration_min, 'min');
        return true;
      } catch (error) {
        log('[JP343 Bridge] Fehler beim Injizieren:', error);
        return false;
      }
    }

    async function syncEntryToServer(
      entry: JP343ImmersionLogEntry,
      userState: JP343UserState,
      originalVideoTitle?: string,
      originalResourceUrl?: string,
      originalThumbnail?: string,
      channelThumbnail?: string
    ): Promise<boolean> {
      const hasAuth = userState.isLoggedIn || userState.guestToken;
      if (!hasAuth || !userState.nonce || !userState.ajaxUrl) {
        return false;
      }

      const videoTitle = originalVideoTitle || entry.project || '';
      const resourceUrl = originalResourceUrl || entry.resourceUrl || '';

      try {
        const params: Record<string, string> = {
          action: 'jp343_log_time',
          nonce: userState.nonce,
          project_id: entry.project_id,
          duration_seconds: String(Math.round(entry.duration_min * 60)),
          source: 'extension',
          session_id: entry.id,
          // Felder die bisher fehlten
          type: entry.type || 'other',
          notes: entry.note || '',
          project_title: entry.project || '',
          project_url: entry.resourceUrl || '',
          project_thumbnail: channelThumbnail || entry.thumbnail || '',
          channel_id: entry.channelId || '',
          channel_name: entry.channelName || '',
          channel_url: entry.channelUrl || '',
          video_title: videoTitle,
          resource_url: resourceUrl,
          thumbnail: originalThumbnail || entry.thumbnail || ''
        };

        if (userState.guestToken) {
          params.guest_token = userState.guestToken;
        }

        const response = await fetch(userState.ajaxUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(params)
        });

        const result = await response.json();
        if (result.success) {
          log('[JP343 Bridge] Entry zu Server gesynct', result.data?.debug || '');
          return true;
        }
        log('[JP343 Bridge] Server antwortete mit Fehler:', result);
        return false;
      } catch (error) {
        log('[JP343 Bridge] Server sync Fehler:', error);
        return false;
      }
    }

    async function markEntrySynced(entryId: string): Promise<void> {
      try {
        await browser.runtime.sendMessage({
          type: 'MARK_ENTRY_SYNCED',
          entryId
        });
      } catch (error) {
        log('[JP343 Bridge] Fehler beim Markieren als synced:', error);
      }
    }

    // Entry als fehlgeschlagen markieren
    async function markEntryFailed(entryId: string, error: string): Promise<void> {
      try {
        await browser.runtime.sendMessage({
          type: 'MARK_ENTRY_FAILED',
          entryId,
          error
        });
      } catch (err) {
        log('[JP343 Bridge] Fehler beim Markieren als failed:', err);
      }
    }

    async function reportUserState(): Promise<void> {
      const userState = getUserState();
      try {
        await browser.runtime.sendMessage({
          type: 'JP343_SITE_LOADED',
          userState
        });
      } catch (_error) {
        // Extension context ungueltig
      }
    }

    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message.type === 'JP343_INJECT_ENTRY' && message.entry) {
        const success = injectEntry(message.entry);
        sendResponse({ success });
      }

      if (message.type === 'JP343_GET_USER_STATE') {
        sendResponse(getUserState());
      }

      return true;
    });

    // EVENT-BASED SYNC FLOW (statt Auto-Sync)

    async function checkPendingEntries(): Promise<void> {
      if (!isExtensionContextValid()) {
        invalidateExtensionContext();
        return;
      }

      try {
        const result = await browser.storage.local.get('jp343_extension_pending');
        const pending: PendingEntry[] = result.jp343_extension_pending || [];
        const unsynced = pending.filter(e => !e.synced);
        const synced = pending.filter(e => e.synced);

        if (unsynced.length === 0) {
          log('[JP343 Bridge] Keine unsynced Entries' + (synced.length > 0 ? ' (' + synced.length + ' synced vorhanden)' : ''));
          return;
        }

        log('[JP343 Bridge] ' + unsynced.length + ' unsynced Entries gefunden' + (synced.length > 0 ? ' + ' + synced.length + ' synced' : '') + ' - zeige Dialog');

        window.dispatchEvent(new CustomEvent('jp343:extension:pending-entries', {
          detail: cloneForPage({ entries: unsynced, syncedEntries: synced })
        }));

      } catch (error) {
        if (error instanceof Error && error.message.includes('Extension context invalidated')) {
          invalidateExtensionContext();
          return;
        }
        log('[JP343 Bridge] Fehler beim Pruefen der pending Entries:', error);
      }
    }

    async function syncConfirmedEntries(
      entries: PendingEntry[],
      projectAssignments: Record<string, { projectId: string; projectName: string }>,
      titleEdits: Record<string, string>,
      channelThumbnails: Record<string, string> = {}
    ): Promise<void> {
      if (!isExtensionContextValid()) {
        invalidateExtensionContext();
        return;
      }

      try {
        const userState = await waitForJP343User();
        log('[JP343 Bridge] Starte Sync von ' + entries.length + ' Entries');

        for (const entry of entries) {
          if (!isExtensionContextValid()) {
            invalidateExtensionContext();
            return;
          }

          try {
            const originalVideoTitle = entry.project;
            const originalResourceUrl = entry.url;
            const originalThumbnail = entry.thumbnail;

            const customTitle = titleEdits[entry.id];
            if (customTitle) {
              entry.project = customTitle;
              log('[JP343 Bridge] Titel geaendert zu:', customTitle);
            }

            const assignment = projectAssignments[entry.id];
            if (assignment && assignment.projectId !== '__keep__') {
              entry.project_id = assignment.projectId;
              entry.project = assignment.projectName;
            }

            const jp343Entry = convertToJP343Format(entry);

            const channelThumb = channelThumbnails[jp343Entry.project_id] || undefined;

            if (userState.isLoggedIn || userState.guestToken) {
              const serverSuccess = await syncEntryToServer(jp343Entry, userState, originalVideoTitle, originalResourceUrl, originalThumbnail, channelThumb);
              if (serverSuccess) {
                await markEntrySynced(entry.id);
                log('[JP343 Bridge] Entry via Server gesynct (kein localStorage):', entry.project);
              } else {
                const localSuccess = injectEntry(jp343Entry);
                if (!localSuccess) {
                  await markEntryFailed(entry.id, 'Server + localStorage failed');
                  continue;
                }
                await markEntryFailed(entry.id, 'Server sync failed, saved locally');
                log('[JP343 Bridge] Server-Sync fehlgeschlagen, lokal gespeichert:', entry.project);
              }
            } else {
              // Gaeste: localStorage reicht
              const localSuccess = injectEntry(jp343Entry);
              if (!localSuccess) {
                await markEntryFailed(entry.id, 'localStorage injection failed');
                continue;
              }
              await markEntrySynced(entry.id);
              log('[JP343 Bridge] Entry lokal gespeichert (Gast):', entry.project);
            }

          } catch (error) {
            if (error instanceof Error && error.message.includes('Extension context invalidated')) {
              invalidateExtensionContext();
              return;
            }
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            await markEntryFailed(entry.id, errorMsg);
            log('[JP343 Bridge] Sync fehlgeschlagen fuer:', entry.id, error);
          }
        }

        window.dispatchEvent(new CustomEvent('jp343:extension:sync-complete'));
        log('[JP343 Bridge] Sync abgeschlossen');

      } catch (error) {
        if (error instanceof Error && error.message.includes('Extension context invalidated')) {
          invalidateExtensionContext();
          return;
        }
        log('[JP343 Bridge] Sync Fehler:', error);
      }
    }

    window.addEventListener('jp343:extension:sync-confirmed', (async (e: CustomEvent) => {
      log('[JP343 Bridge] Sync-Bestaetigung erhalten');
      const { entries, projectAssignments, titleEdits, channelThumbnails } = e.detail || {};
      if (!entries || !Array.isArray(entries)) return;

      const result = await browser.storage.local.get('jp343_extension_pending');
      const pending: PendingEntry[] = result.jp343_extension_pending || [];
      const pendingIds = new Set(pending.map(p => p.id));

      const validEntries = entries.filter((entry: PendingEntry) => pendingIds.has(entry.id));
      if (validEntries.length > 0) {
        syncConfirmedEntries(validEntries, projectAssignments || {}, titleEdits || {}, channelThumbnails || {});
      }
    }) as EventListener);

    window.addEventListener('jp343:extension:sync-skipped', () => {
      log('[JP343 Bridge] Sync uebersprungen');
    });

    // Initial: User State melden
    reportUserState();

    setTimeout(() => {
      if (isExtensionContextValid()) {
        checkPendingEntries();
      }
    }, 2000);

    syncIntervalId = setInterval(() => {
      if (isExtensionContextValid()) {
        checkPendingEntries();
      } else {
        invalidateExtensionContext();
      }
    }, 60000);
  }
});
