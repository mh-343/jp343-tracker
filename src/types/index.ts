export type Platform = 'youtube' | 'netflix' | 'crunchyroll' | 'primevideo' | 'disneyplus' | 'cijapanese' | 'generic';

export type ActivityType = 'watching' | 'listening' | 'reading' | 'speaking';

export const PLATFORM_ACTIVITY_TYPE: Record<Platform, ActivityType> = {
  youtube: 'watching',
  netflix: 'watching',
  crunchyroll: 'watching',
  primevideo: 'watching',
  disneyplus: 'watching',
  generic: 'watching',
};

export interface VideoState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  title: string;
  url: string;
  platform: Platform;
  isAd: boolean;
  thumbnailUrl: string | null;
  videoId: string | null;
  channelId: string | null;
  channelName: string | null;
  channelUrl: string | null;
}

export interface TrackingSession {
  id: string;
  platform: Platform;
  title: string;
  url: string;
  videoId: string | null;
  tabId: number | null;
  startTime: number;
  accumulatedMs: number;
  lastUpdate: number;
  isActive: boolean;
  isPaused: boolean;
  thumbnailUrl: string | null;
  titleManuallyEdited?: boolean;
  channelId: string | null;
  channelName: string | null;
  channelUrl: string | null;
  activityType?: ActivityType;
}

export interface PendingEntry {
  id: string;
  date: string;
  duration_min: number;
  project: string;
  project_id: string;
  platform: Platform;
  source: 'extension';
  url: string;
  thumbnail: string | null;
  synced: boolean;
  syncedAt: string | null;
  syncAttempts: number;
  lastSyncError: string | null;
  serverEntryId: number | null;
  channelId: string | null;
  channelName: string | null;
  channelUrl: string | null;
  activityType?: ActivityType;
}

export interface JP343UserState {
  isLoggedIn: boolean;
  userId: number | null;
  nonce: string | null;
  ajaxUrl: string | null;
  extApiToken: string | null;
}

export interface ExtensionStorage {
  jp343_extension_pending: PendingEntry[];
  jp343_extension_session: TrackingSession | null;
  jp343_extension_user: JP343UserState | null;
  jp343_extension_settings: ExtensionSettings;
  jp343_extension_stats: ExtensionStats;
}

export interface ExtensionSettings {
  enabled: boolean;
  autoSync: boolean;
  minDurationMinutes: number;
  enabledPlatforms: Platform[];
  blockedChannels: BlockedChannel[];
}

export interface BlockedChannel {
  channelId: string;
  channelName: string;
  channelUrl: string | null;
  blockedAt: string;
}

export type ExtensionMessage =
  | { type: 'VIDEO_PLAY'; platform: Platform; state: VideoState; tabId?: number }
  | { type: 'VIDEO_PAUSE'; platform: Platform }
  | { type: 'VIDEO_ENDED'; platform: Platform }
  | { type: 'AD_START'; platform: Platform }
  | { type: 'AD_END'; platform: Platform }
  | { type: 'VIDEO_STATE_UPDATE'; platform: Platform; state: VideoState }
  | { type: 'JP343_SITE_LOADED'; userState: JP343UserState }
  | { type: 'JP343_GET_USER_STATE' }
  | { type: 'GET_CURRENT_SESSION' }
  | { type: 'GET_PENDING_ENTRIES' }
  | { type: 'DELETE_PENDING_ENTRY'; entryId: string }
  | { type: 'DELETE_PENDING_BY_SERVER_ID'; serverEntryId: number }
  | { type: 'CLEAR_SYNCED_ENTRIES' }
  | { type: 'STOP_SESSION' }
  | { type: 'PAUSE_SESSION' }
  | { type: 'RESUME_SESSION' }
  | { type: 'GET_SETTINGS' }
  | { type: 'SET_ENABLED'; enabled: boolean }
  | { type: 'BLOCK_CHANNEL'; channel: BlockedChannel }
  | { type: 'UNBLOCK_CHANNEL'; channelId: string }
  | { type: 'GET_CURRENT_CHANNEL' }
  | { type: 'UPDATE_SESSION_TITLE'; title: string }
  | { type: 'UPDATE_PENDING_ENTRY_TITLE'; entryId: string; title: string }
  | { type: 'MANUAL_TRACK_START'; title: string; url: string; tabId: number; activityType: ActivityType }
  | { type: 'GET_ACTIVE_TAB_INFO' }
  | { type: 'GET_STATS' }
  | { type: 'RESET_STATS' }
  | { type: 'SYNC_ENTRIES_DIRECT' }
  | { type: 'OPEN_DASHBOARD' };

export interface DirectSyncResult {
  attempted: number;
  succeeded: number;
  failed: number;
  noAuth: boolean;
  nonceMissing: boolean;
}

export type ExtensionResponse =
  | { success: true; data?: unknown }
  | { success: false; error: string };

export interface ActiveTabInfo {
  tabId: number;
  url: string;
  title: string;
  domain: string;
  isStreamingSite: boolean;
}

export interface ExtensionStats {
  totalMinutes: number;
  dailyMinutes: Record<string, number>;
  lastActiveDate: string;
  currentStreak: number;
}

export const DEFAULT_STATS: ExtensionStats = {
  totalMinutes: 0,
  dailyMinutes: {},
  lastActiveDate: '',
  currentStreak: 0
};

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  autoSync: true,
  minDurationMinutes: 1,
  enabledPlatforms: ['youtube', 'netflix', 'crunchyroll', 'primevideo', 'disneyplus', 'cijapanese'],
  blockedChannels: []
};

export const STORAGE_KEYS = {
  PENDING: 'jp343_extension_pending',
  SESSION: 'jp343_extension_session',
  USER: 'jp343_extension_user',
  SETTINGS: 'jp343_extension_settings',
  STATS: 'jp343_extension_stats',
  DISPLAY_NAME: 'jp343_extension_display_name'
} as const;
