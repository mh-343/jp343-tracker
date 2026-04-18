import type {
  DirectSyncResult,
  ExtensionSettings,
  ExtensionStats,
  PendingEntry,
  TrackingSession,
} from '../../types';

export interface BackgroundMessageContext {
  log: (...args: unknown[]) => void;
  loadSettings: () => Promise<ExtensionSettings>;
  saveSettings: (settings: ExtensionSettings) => Promise<void>;
  ensureFreshSettings: () => Promise<void>;
  syncSettingsToServer: (settings: ExtensionSettings) => Promise<void>;
  savePendingEntry: (entry: PendingEntry) => Promise<void>;
  saveSessionState: (session: TrackingSession | null) => Promise<void>;
  loadStats: () => Promise<ExtensionStats>;
  subtractFromStats: (entry: PendingEntry) => Promise<void>;
  syncEntriesDirect: () => Promise<DirectSyncResult>;
  pullAndMergeSettingsFromServer: () => Promise<void>;
  fetchAndCacheServerStats: () => Promise<void>;
}
