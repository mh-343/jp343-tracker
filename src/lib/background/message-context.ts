import type {
  ChannelOp,
  DirectSyncResult,
  ExtensionSettings,
  ExtensionStats,
  PendingEntry,
  SavePendingResult,
  TrackingSession,
} from '../../types';

export interface SkippedChannelInfo {
  channelId: string;
  channelName: string;
  channelUrl: string | null;
}

export interface BackgroundMessageContext {
  log: (...args: unknown[]) => void;
  loadSettings: () => Promise<ExtensionSettings>;
  saveSettings: (settings: ExtensionSettings) => Promise<void>;
  ensureFreshSettings: () => Promise<void>;
  syncSettingsToServer: (settings: ExtensionSettings) => Promise<void>;
  applyChannelOp: (op: Omit<ChannelOp, 'opId' | 'timestamp'>) => Promise<void>;
  savePendingEntry: (entry: PendingEntry) => Promise<SavePendingResult>;
  saveSessionState: (session: TrackingSession | null) => Promise<void>;
  loadStats: () => Promise<ExtensionStats>;
  subtractFromStats: (entry: PendingEntry) => Promise<void>;
  syncEntriesDirect: () => Promise<DirectSyncResult>;
  pullAndMergeSettingsFromServer: () => Promise<boolean>;
  fetchAndCacheServerStats: () => Promise<void>;
  recoveryReady: Promise<void>;
  setLastSkippedChannel: (info: SkippedChannelInfo | null) => void;
  getLastSkippedChannel: () => SkippedChannelInfo | null;
  fetchAndStoreAvatar: (url: string, userId: number) => Promise<void>;
  pullChannelsFromServer: () => Promise<void>;
  finalizeRevokedCustomOrigins: (origins: string[]) => Promise<void>;
}
