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
    '*://localhost/*',
    '*://127.0.0.1/*'
  ],
  runAt: 'document_idle',

  main() {
    console.log('[JP343 Bridge] Content Script geladen');

    const version = browser.runtime.getManifest().version;
    document.documentElement.setAttribute('data-jp343-extension', version);
    console.log('[JP343 Bridge] Extension v' + version + ' signalisiert');

    function injectUserStateScript(): void {
      const script = document.createElement('script');
      script.src = browser.runtime.getURL('inject-user-state.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    }

    injectUserStateScript();

    const STORAGE_KEYS = {
      IMMERSION_LOG: 'jp343_immersion_log',
      PROJECTS: 'jp343_tracker_projects'
    };

    let extensionContextValid = true;
    let syncIntervalId: ReturnType<typeof setInterval> | null = null;

    function isExtensionContextValid(): boolean {
      try {
        return extensionContextValid && !!browser.runtime?.id;
      } catch {
        return false;
      }
    }

    function invalidateExtensionContext(): void {
      if (extensionContextValid) {
        console.log('[JP343 Bridge] Extension Context ungueltig - stoppe Sync');
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
            console.log('[JP343 Bridge] User State:', userState.isLoggedIn ? 'eingeloggt' : 'Gast');
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
          return {
            isLoggedIn: userData.isLoggedIn || false,
            userId: userData.userId || null,
            nonce: userData.nonce || null,
            ajaxUrl: userData.ajaxUrl || null
          };
        } catch (e) {
          console.error('[JP343 Bridge] Fehler beim Parsen von data-jp343-user:', e);
        }
      }

      return {
        isLoggedIn: false,
        userId: null,
        nonce: null,
        ajaxUrl: null
      };
    }

    function getActivityType(platform: Platform): 'watching' | 'reading' | 'listening' | 'other' {
      const watchingPlatforms: Platform[] = ['youtube', 'netflix', 'crunchyroll'];
      return watchingPlatforms.includes(platform) ? 'watching' : 'other';
    }

    function getPlatformIcon(platform: Platform): string {
      const icons: Record<Platform, string> = {
        youtube: 'logos:youtube-icon',
        netflix: 'logos:netflix-icon',
        crunchyroll: 'simple-icons:crunchyroll',
        generic: 'mdi:play-circle'
      };
      return icons[platform] || icons.generic;
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

    function entryExists(log: JP343ImmersionLogEntry[], entryId: string): boolean {
      return log.some(e => e.id === entryId || e.sessionId === entryId);
    }

    function injectEntry(entry: JP343ImmersionLogEntry): boolean {
      try {
        const logData = localStorage.getItem(STORAGE_KEYS.IMMERSION_LOG);
        const log: JP343ImmersionLogEntry[] = logData ? JSON.parse(logData) : [];

        if (entryExists(log, entry.id)) {
          console.log('[JP343 Bridge] Entry existiert bereits:', entry.id);
          return true;
        }

        log.push(entry);
        localStorage.setItem(STORAGE_KEYS.IMMERSION_LOG, JSON.stringify(log));

        window.dispatchEvent(new CustomEvent('jp343:tracker:changed', {
          detail: { entry, action: 'log_added', source: 'extension' }
        }));

        console.log('[JP343 Bridge] Entry injiziert:', entry.project, entry.duration_min, 'min');
        return true;
      } catch (error) {
        console.error('[JP343 Bridge] Fehler beim Injizieren:', error);
        return false;
      }
    }

    function ensureProjectExists(entry: PendingEntry): void {
      try {
        const projectsData = localStorage.getItem(STORAGE_KEYS.PROJECTS);
        const projects = projectsData ? JSON.parse(projectsData) : [];

        const projectName = entry.channelName || entry.project;

        const exists = projects.some((p: { id?: string; name?: string }) =>
          p.id === entry.project_id || p.name === projectName
        );

        if (exists) return;

        const newProject = {
          id: entry.project_id,
          name: projectName,
          icon: getPlatformIcon(entry.platform),
          color: '#875aff',
          image: entry.thumbnail,
          resourceUrl: entry.url,
          isCustom: true,
          source: 'extension',
          platform: entry.platform
        };

        projects.push(newProject);
        localStorage.setItem(STORAGE_KEYS.PROJECTS, JSON.stringify(projects));

        window.dispatchEvent(new CustomEvent('jp343:projects:changed', {
          detail: { project: newProject, action: 'created' }
        }));

        console.log('[JP343 Bridge] Projekt erstellt:', newProject.name);
      } catch (error) {
        console.error('[JP343 Bridge] Fehler beim Projekt erstellen:', error);
      }
    }

    async function syncEntryToServer(
      entry: JP343ImmersionLogEntry,
      userState: JP343UserState,
      originalVideoTitle?: string,
      originalResourceUrl?: string
    ): Promise<boolean> {
      if (!userState.isLoggedIn || !userState.nonce || !userState.ajaxUrl) {
        return false;
      }

      const videoTitle = originalVideoTitle || entry.project || '';
      const resourceUrl = originalResourceUrl || entry.resourceUrl || '';

      try {
        const response = await fetch(userState.ajaxUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            action: 'jp343_log_time',
            nonce: userState.nonce,
            project_id: entry.project_id,
            duration_seconds: String(entry.duration_min * 60),
            source: 'extension',
            session_id: entry.id,
            project_title: entry.project || '',
            project_url: entry.resourceUrl || '',
            project_thumbnail: entry.thumbnail || '',
            channel_id: entry.channelId || '',
            channel_name: entry.channelName || '',
            channel_url: entry.channelUrl || '',
            video_title: videoTitle,
            resource_url: resourceUrl
          })
        });

        const result = await response.json();
        if (result.success) {
          console.log('[JP343 Bridge] Entry zu Server gesynct', result.data?.debug || '');
          return true;
        }
        console.warn('[JP343 Bridge] Server antwortete mit Fehler:', result);
        return false;
      } catch (error) {
        console.error('[JP343 Bridge] Server sync Fehler:', error);
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
        console.error('[JP343 Bridge] Fehler beim Markieren als synced:', error);
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
        console.error('[JP343 Bridge] Fehler beim Markieren als failed:', err);
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

        if (unsynced.length === 0) {
          console.log('[JP343 Bridge] Keine unsynced Entries');
          return;
        }

        console.log('[JP343 Bridge] ' + unsynced.length + ' unsynced Entries gefunden - zeige Dialog');

        window.dispatchEvent(new CustomEvent('jp343:extension:pending-entries', {
          detail: { entries: unsynced }
        }));

      } catch (error) {
        if (error instanceof Error && error.message.includes('Extension context invalidated')) {
          invalidateExtensionContext();
          return;
        }
        console.error('[JP343 Bridge] Fehler beim Pruefen der pending Entries:', error);
      }
    }

    async function syncConfirmedEntries(
      entries: PendingEntry[],
      projectAssignments: Record<string, { projectId: string; projectName: string }>,
      titleEdits: Record<string, string>
    ): Promise<void> {
      if (!isExtensionContextValid()) {
        invalidateExtensionContext();
        return;
      }

      try {
        const userState = await waitForJP343User();
        console.log('[JP343 Bridge] Starte Sync von ' + entries.length + ' Entries');

        for (const entry of entries) {
          if (!isExtensionContextValid()) {
            invalidateExtensionContext();
            return;
          }

          try {
            const originalVideoTitle = entry.project;
            const originalResourceUrl = entry.url;

            const customTitle = titleEdits[entry.id];
            if (customTitle) {
              entry.project = customTitle;
              console.log('[JP343 Bridge] Titel geaendert zu:', customTitle);
            }

            const assignment = projectAssignments[entry.id];
            if (assignment && assignment.projectId !== '__keep__') {
              entry.project_id = assignment.projectId;
              entry.project = assignment.projectName;
            }

            // Projekt sicherstellen
            ensureProjectExists(entry);

            // In localStorage injizieren
            const jp343Entry = convertToJP343Format(entry);
            const localSuccess = injectEntry(jp343Entry);

            if (!localSuccess) {
              await markEntryFailed(entry.id, 'localStorage injection failed');
              continue;
            }

            if (userState.isLoggedIn) {
              const serverSuccess = await syncEntryToServer(jp343Entry, userState, originalVideoTitle, originalResourceUrl);
              if (!serverSuccess) {
                await markEntryFailed(entry.id, 'Server sync failed');
                console.error('[JP343 Bridge] Server sync fehlgeschlagen - Entry bleibt pending');
                continue;
              }
            }

            await markEntrySynced(entry.id);
            console.log('[JP343 Bridge] Entry synced:', entry.project);

          } catch (error) {
            if (error instanceof Error && error.message.includes('Extension context invalidated')) {
              invalidateExtensionContext();
              return;
            }
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            await markEntryFailed(entry.id, errorMsg);
            console.error('[JP343 Bridge] Sync fehlgeschlagen fuer:', entry.id, error);
          }
        }

        window.dispatchEvent(new CustomEvent('jp343:extension:sync-complete'));
        console.log('[JP343 Bridge] Sync abgeschlossen');

      } catch (error) {
        if (error instanceof Error && error.message.includes('Extension context invalidated')) {
          invalidateExtensionContext();
          return;
        }
        console.error('[JP343 Bridge] Sync Fehler:', error);
      }
    }

    window.addEventListener('jp343:extension:sync-confirmed', ((e: CustomEvent) => {
      console.log('[JP343 Bridge] Sync-Bestaetigung erhalten');
      const { entries, projectAssignments, titleEdits } = e.detail || {};
      if (entries && Array.isArray(entries)) {
        syncConfirmedEntries(entries, projectAssignments || {}, titleEdits || {});
      }
    }) as EventListener);

    window.addEventListener('jp343:extension:sync-skipped', () => {
      console.log('[JP343 Bridge] Sync uebersprungen');
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
