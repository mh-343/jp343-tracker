import type { ExtensionSettings, PendingEntry, ExtensionStats, AnkiState, AnkiCollectionState, JP343UserState } from '../../types';
import { STORAGE_KEYS, DEFAULT_SETTINGS, ANKI_SCHEMA_VERSION } from '../../types';
import { getLocalDateString } from '../../lib/format-utils';
import { invalidateSessionCache } from './sessions';
import { showStatus } from './settings-helpers';

interface ExportData {
  exportVersion: 1;
  exportedAt: string;
  extensionVersion: string;
  data: {
    settings: ExtensionSettings;
    entries: PendingEntry[];
    stats: ExtensionStats;
    anki?: AnkiState;
  };
}

export function buildExportImportPanel(container: HTMLElement): void {
  const section = document.createElement('div');
  section.className = 'settings-section';

  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'Backup';
  section.appendChild(title);

  const desc = document.createElement('div');
  desc.className = 'settings-row-desc';
  desc.textContent = 'Backup your sessions, stats, and settings as a JSON file.';
  desc.style.marginBottom = '16px';
  section.appendChild(desc);

  const actions = document.createElement('div');
  actions.className = 'export-import-actions';

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'export-btn';
  exportBtn.textContent = 'Download Backup';
  exportBtn.addEventListener('click', () => handleExport(section));
  actions.appendChild(exportBtn);

  const importLabel = document.createElement('label');
  importLabel.className = 'import-label';
  importLabel.textContent = 'Restore Backup';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json';
  fileInput.className = 'import-file-input';
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) handleImportFile(file, section);
    fileInput.value = '';
  });
  importLabel.appendChild(fileInput);
  actions.appendChild(importLabel);

  section.appendChild(actions);
  container.appendChild(section);
}

async function handleExport(statusContainer: HTMLElement): Promise<void> {
  try {
    const result = await browser.storage.local.get([
      STORAGE_KEYS.PENDING,
      STORAGE_KEYS.STATS,
      STORAGE_KEYS.SETTINGS,
      STORAGE_KEYS.ANKI
    ]);

    const data: ExportData = {
      exportVersion: 1,
      exportedAt: new Date().toISOString(),
      extensionVersion: browser.runtime.getManifest().version,
      data: {
        settings: result[STORAGE_KEYS.SETTINGS] || { ...DEFAULT_SETTINGS },
        entries: result[STORAGE_KEYS.PENDING] || [],
        stats: result[STORAGE_KEYS.STATS] || { totalMinutes: 0, dailyMinutes: {}, lastActiveDate: '', currentStreak: 0 },
        anki: result[STORAGE_KEYS.ANKI] as AnkiState | undefined
      }
    };

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jp343-backup-${getLocalDateString()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus(statusContainer, 'Export downloaded', 'success');
  } catch (error) {
    showStatus(statusContainer, 'Export failed: ' + (error instanceof Error ? error.message : 'Unknown error'), 'error');
  }
}

async function handleImportFile(file: File, statusContainer: HTMLElement): Promise<void> {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text) as ExportData;

    if (parsed.exportVersion !== 1 || !parsed.data) {
      showStatus(statusContainer, 'Invalid backup file format', 'error');
      return;
    }
    if (!Array.isArray(parsed.data.entries) || typeof parsed.data.stats?.dailyMinutes !== 'object') {
      showStatus(statusContainer, 'Backup file has invalid data structure', 'error');
      return;
    }

    showImportPreview(statusContainer, parsed);
  } catch {
    showStatus(statusContainer, 'Failed to read backup file', 'error');
  }
}

function showImportPreview(container: HTMLElement, data: ExportData): void {
  const existing = container.querySelector('.import-preview');
  if (existing) existing.remove();

  const preview = document.createElement('div');
  preview.className = 'import-preview';

  const title = document.createElement('div');
  title.className = 'import-preview-title';
  title.textContent = 'Import Preview';
  preview.appendChild(title);

  const stats = document.createElement('div');
  stats.className = 'import-preview-stats';
  const entryCount = data.data.entries.length;
  const dayCount = Object.keys(data.data.stats.dailyMinutes || {}).length;
  const version = data.extensionVersion || 'unknown';
  const date = data.exportedAt ? new Date(data.exportedAt).toLocaleDateString() : 'unknown';
  stats.textContent = `${entryCount} sessions, ${dayCount} days of stats. Exported from v${version} on ${date}.`;
  preview.appendChild(stats);

  const actions = document.createElement('div');
  actions.className = 'import-preview-actions';

  const btnEntriesOnly = document.createElement('button');
  btnEntriesOnly.type = 'button';
  btnEntriesOnly.className = 'import-btn';
  btnEntriesOnly.textContent = 'Import sessions only';
  btnEntriesOnly.addEventListener('click', () => {
    executeImport(data, false, container);
  });

  const btnAll = document.createElement('button');
  btnAll.type = 'button';
  btnAll.className = 'import-btn-secondary';
  btnAll.textContent = 'Import sessions + settings';
  btnAll.addEventListener('click', () => {
    executeImport(data, true, container);
  });

  const btnCancel = document.createElement('button');
  btnCancel.type = 'button';
  btnCancel.className = 'import-btn-secondary';
  btnCancel.textContent = 'Cancel';
  btnCancel.addEventListener('click', () => { preview.remove(); });

  actions.appendChild(btnEntriesOnly);
  actions.appendChild(btnAll);
  actions.appendChild(btnCancel);
  preview.appendChild(actions);
  container.appendChild(preview);
}

// strip dirtyDays so an import can't push
function sanitizeImportedAnki(raw: unknown): AnkiState | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Partial<AnkiState>;
  if (!a.collections || typeof a.collections !== 'object') return null;
  const collections: Record<string, AnkiCollectionState> = {};
  for (const [key, c] of Object.entries(a.collections)) {
    const col = (c || {}) as Partial<AnkiCollectionState>;
    collections[key] = {
      lastSyncId: typeof col.lastSyncId === 'number' ? col.lastSyncId : 0,
      backfillDone: !!col.backfillDone,
      days: col.days && typeof col.days === 'object' ? col.days : {},
      seenCardIds: Array.isArray(col.seenCardIds) ? col.seenCardIds : [],
      dirtyDays: [],
      lastPushedAt: typeof col.lastPushedAt === 'number' ? col.lastPushedAt : null,
      lastPushError: null
    };
  }
  return {
    schemaVersion: typeof a.schemaVersion === 'number' ? a.schemaVersion : ANKI_SCHEMA_VERSION,
    enabled: !!a.enabled,
    selectedDecks: Array.isArray(a.selectedDecks) ? a.selectedDecks : [],
    status: 'idle',
    lastSyncAt: typeof a.lastSyncAt === 'number' ? a.lastSyncAt : null,
    activeCollection: typeof a.activeCollection === 'string' ? a.activeCollection : null,
    pendingServerReset: false,
    collections
  };
}

async function executeImport(data: ExportData, includeSettings: boolean, statusContainer: HTMLElement): Promise<void> {
  try {
    const updates: Record<string, unknown> = {};
    if (data.data.anki) {
      const cleanAnki = sanitizeImportedAnki(data.data.anki);
      if (cleanAnki) updates[STORAGE_KEYS.ANKI] = cleanAnki;
    }

    let isLoggedIn = false;
    let importDayStartHour: number;
    if (includeSettings && data.data.settings) {
      const imported = { ...DEFAULT_SETTINGS, ...data.data.settings };
      imported.dayStartHour = Math.max(0, Math.min(6, imported.dayStartHour || 0));
      importDayStartHour = imported.dayStartHour;

      const userResult = await browser.storage.local.get(STORAGE_KEYS.USER);
      const userState = userResult[STORAGE_KEYS.USER] as JP343UserState | undefined;
      isLoggedIn = !!userState?.extApiToken;
      if (isLoggedIn) {
        delete (imported as Record<string, unknown>).blockedChannels;
        delete (imported as Record<string, unknown>).whitelistedChannels;
      }

      updates[STORAGE_KEYS.SETTINGS] = imported;
    } else {
      const current = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
      const currentSettings = current[STORAGE_KEYS.SETTINGS] as ExtensionSettings | undefined;
      importDayStartHour = Math.max(0, Math.min(6, currentSettings?.dayStartHour || 0));
    }

    const result = await browser.runtime.sendMessage({
      type: 'IMPORT_PENDING_BACKUP', entries: data.data.entries, stats: data.data.stats, dayStartHour: importDayStartHour
    }) as { success?: boolean; data?: { added: number }; error?: string };
    if (!result?.success || !result.data) throw new Error(result?.error || 'Import failed');
    const added = result.data.added;
    await browser.storage.local.set(updates);
    invalidateSessionCache();
    document.dispatchEvent(new CustomEvent('jp343:refresh'));

    if (includeSettings && isLoggedIn) {
      browser.runtime.sendMessage({ type: 'PULL_CHANNELS' }).catch(() => {});
    }

    const preview = statusContainer.querySelector('.import-preview');
    if (preview) preview.remove();

    const msg = added > 0
      ? `${added} new sessions added` + (includeSettings ? ' and settings applied' : '')
      : 'No new sessions found (all already present)' + (includeSettings ? ', settings applied' : '');
    showStatus(statusContainer, msg, 'success');
  } catch (error) {
    showStatus(statusContainer, 'Import failed: ' + (error instanceof Error ? error.message : 'Unknown error'), 'error');
  }
}
