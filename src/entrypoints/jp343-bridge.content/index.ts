// =============================================================================
// JP343 Extension - Bridge Content Script
// Laeuft auf JP343-Seite und synchronisiert Daten SICHER
// Entries werden NIE geloescht - nur als synced markiert!
// =============================================================================

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

    const STORAGE_KEYS = {
      IMMERSION_LOG: 'jp343_immersion_log',
      PROJECTS: 'jp343_tracker_projects'
    };

    // Flag um zu erkennen ob Extension Context noch gueltig ist
    let extensionContextValid = true;
    let syncIntervalId: ReturnType<typeof setInterval> | null = null;

    // Pruefen ob Extension Context noch gueltig ist
    function isExtensionContextValid(): boolean {
      try {
        // Wenn browser.runtime.id undefined ist, ist der Context ungueltig
        return extensionContextValid && !!browser.runtime?.id;
      } catch {
        return false;
      }
    }

    // Extension Context als ungueltig markieren und Interval stoppen
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

    // Warten bis JP343_USER verfuegbar ist
    function waitForJP343User(maxWait = 5000): Promise<JP343UserState> {
      return new Promise((resolve) => {
        const startTime = Date.now();

        const check = () => {
          const userState = getUserState();

          // Wenn User State vorhanden oder Timeout
          if (userState.ajaxUrl || Date.now() - startTime > maxWait) {
            resolve(userState);
            return;
          }

          // Nochmal versuchen
          setTimeout(check, 200);
        };

        check();
      });
    }

    function getUserState(): JP343UserState {
      const jp343User = (window as unknown as { JP343_USER?: {
        isLoggedIn?: boolean;
        userId?: number;
        nonce?: string;
        ajaxUrl?: string;
      } }).JP343_USER;

      return {
        isLoggedIn: jp343User?.isLoggedIn || false,
        userId: jp343User?.userId || null,
        nonce: jp343User?.nonce || null,
        ajaxUrl: jp343User?.ajaxUrl || null
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
        // Channel-Informationen (fuer Website-seitige Zuordnung)
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
          // Entry existiert schon - das ist OK, als synced markieren
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

        const exists = projects.some((p: { id?: string; name?: string }) =>
          p.id === entry.project_id || p.name === entry.project
        );

        if (exists) return;

        const newProject = {
          id: entry.project_id,
          name: entry.project,
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

    async function syncEntryToServer(entry: JP343ImmersionLogEntry, userState: JP343UserState): Promise<boolean> {
      if (!userState.isLoggedIn || !userState.nonce || !userState.ajaxUrl) {
        return false;
      }

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
            session_id: entry.id
          })
        });

        const result = await response.json();
        if (result.success) {
          console.log('[JP343 Bridge] Entry zu Server gesynct');
          return true;
        }
        console.warn('[JP343 Bridge] Server antwortete mit Fehler:', result);
        return false;
      } catch (error) {
        console.error('[JP343 Bridge] Server sync Fehler:', error);
        return false;
      }
    }

    // Entry als synced markieren (NICHT loeschen!)
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

    async function syncPendingEntries(): Promise<void> {
      // Frueh abbrechen wenn Context ungueltig
      if (!isExtensionContextValid()) {
        invalidateExtensionContext();
        return;
      }

      try {
        // Warten bis JP343_USER verfuegbar (max 5 Sekunden)
        const userState = await waitForJP343User();

        const result = await browser.storage.local.get('jp343_extension_pending');
        const pending: PendingEntry[] = result.jp343_extension_pending || [];

        // Nur unsynced Entries verarbeiten
        const unsynced = pending.filter(e => !e.synced);

        if (unsynced.length === 0) {
          console.log('[JP343 Bridge] Keine unsynced Entries');
          return;
        }

        console.log('[JP343 Bridge] Synce', unsynced.length, 'Entries');

        for (const entry of unsynced) {
          // Check vor jedem Entry
          if (!isExtensionContextValid()) {
            invalidateExtensionContext();
            return;
          }

          try {
            // Projekt sicherstellen
            ensureProjectExists(entry);

            // In localStorage injizieren
            const jp343Entry = convertToJP343Format(entry);
            const localSuccess = injectEntry(jp343Entry);

            if (!localSuccess) {
              await markEntryFailed(entry.id, 'localStorage injection failed');
              continue;
            }

            // Fuer eingeloggte User: Auch zum Server syncen
            if (userState.isLoggedIn) {
              const serverSuccess = await syncEntryToServer(jp343Entry, userState);
              if (!serverSuccess) {
                // Server sync fehlgeschlagen, aber localStorage war OK
                // Trotzdem als "synced" markieren (localStorage reicht fuer Guests)
                // User kann spaeter nochmal versuchen
                console.warn('[JP343 Bridge] Server sync fehlgeschlagen, aber localStorage OK');
              }
            }

            // WICHTIG: Entry als synced markieren (NICHT loeschen!)
            await markEntrySynced(entry.id);
            console.log('[JP343 Bridge] Entry synced:', entry.project);

          } catch (error) {
            // "Extension context invalidated" abfangen
            if (error instanceof Error && error.message.includes('Extension context invalidated')) {
              invalidateExtensionContext();
              return;
            }
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            await markEntryFailed(entry.id, errorMsg);
            console.error('[JP343 Bridge] Sync fehlgeschlagen fuer:', entry.id, error);
          }
        }

        console.log('[JP343 Bridge] Sync abgeschlossen');
      } catch (error) {
        // "Extension context invalidated" abfangen
        if (error instanceof Error && error.message.includes('Extension context invalidated')) {
          invalidateExtensionContext();
          return;
        }
        console.error('[JP343 Bridge] Sync Fehler:', error);
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

    // Initial: User State melden
    reportUserState();

    // Etwas laenger warten bis Seite vollstaendig geladen
    setTimeout(() => {
      if (isExtensionContextValid()) {
        syncPendingEntries();
      }
    }, 2000);

    // Periodisch syncen (alle 30 Sekunden)
    syncIntervalId = setInterval(() => {
      if (isExtensionContextValid()) {
        syncPendingEntries();
      } else {
        invalidateExtensionContext();
      }
    }, 30000);
  }
});
