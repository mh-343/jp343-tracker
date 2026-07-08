import type { DifficultySeed } from '../lib/difficulty-seeds';

export type Platform = 'youtube' | 'netflix' | 'crunchyroll' | 'primevideo' | 'disneyplus' | 'cijapanese' | 'nihongojikan' | 'spotify' | 'twitch' | 'asbplayer' | 'mokuro' | 'generic';

export type ActivityType = 'watching' | 'listening' | 'reading' | 'speaking' | 'other';

export type SpotifyContentType = 'music' | 'podcast' | 'audiobook';

export type ColorTheme = 'magenta' | 'matcha' | 'ocean';

export const COLOR_THEMES: Record<ColorTheme, { label: string; swatch: string }> = {
  magenta: { label: 'Magenta', swatch: '#e91e8b' },
  matcha:  { label: 'Matcha',  swatch: '#4caf50' },
  ocean:   { label: 'Ocean',   swatch: '#2196f3' }
};

export const PLATFORM_ACTIVITY_TYPE: Record<Platform, ActivityType> = {
  youtube: 'watching',
  netflix: 'watching',
  crunchyroll: 'watching',
  primevideo: 'watching',
  disneyplus: 'watching',
  cijapanese: 'watching',
  nihongojikan: 'watching',
  spotify: 'listening',
  twitch: 'watching',
  asbplayer: 'watching',
  mokuro: 'reading',
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
  originalTitle?: string | null;
  audioLanguage?: string | null;
  description?: string | null;
  contentType?: SpotifyContentType;
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
  audioLanguage?: string | null;
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
  mergeResync?: boolean;
  chars?: number;
  readingCurrentPage?: number;
  readingCompleted?: boolean;
}

export interface JP343UserState {
  isLoggedIn: boolean;
  userId: number | null;
  nonce: string | null;
  ajaxUrl: string | null;
  extApiToken: string | null;
  avatarUrlSmall: string | null;
}

export interface ExtensionStorage {
  jp343_extension_pending: PendingEntry[];
  jp343_extension_session: TrackingSession | null;
  jp343_extension_user: JP343UserState | null;
  jp343_extension_settings: ExtensionSettings;
  jp343_extension_stats: ExtensionStats;
  jp343_cached_server_stats?: Record<string, unknown>;
}

export interface ExtensionSettings {
  enabled: boolean;
  autoSync: boolean;
  mergeSameDaySessions: boolean;
  minDurationMinutes: number;
  enabledPlatforms: Platform[];
  blockedChannels: BlockedChannel[];
  spotifyContentTypes: SpotifyContentType[];
  dailyGoalMinutes: number;
  dayStartHour: number;
  hideNonJapanese: boolean;
  trackJapaneseOnly: boolean;
  whitelistedChannels: WhitelistedChannel[];
  useOriginalTitles: boolean;
  diagnosticsEnabled: boolean;
  backgroundEnabled: boolean;
  backgroundOpacity: number;
  colorTheme: ColorTheme;
  targetStartTimes: (string | null)[];
  stretchGoalsEnabled: boolean;
  streakRiskNotification: boolean;
  showDifficultyLevels?: boolean;
  difficultyLocalOnly?: boolean;
  difficultyVotingEnabled?: boolean;
  difficultyContribEnabled?: boolean;
  platformDefaultsMigrated?: boolean;
}

export interface BlockedChannel {
  channelId: string;
  channelName: string;
  channelUrl: string | null;
  blockedAt: string;
}

export interface WhitelistedChannel {
  channelId: string;
  channelName: string;
  channelUrl: string | null;
  whitelistedAt: string;
}

export interface ChannelOp {
  opId: string;
  action: 'block' | 'unblock' | 'whitelist' | 'unwhitelist';
  channelId: string;
  channelName: string;
  channelUrl: string | null;
  timestamp: string;
}

export interface ChannelSyncState {
  initialized: boolean;
  serverVersion: number;
  serverSnapshot: {
    blocked: BlockedChannel[];
    whitelisted: WhitelistedChannel[];
  };
  pendingOps: ChannelOp[];
  lastPullAt: string | null;
}

export interface ChannelOpsResponse {
  success: boolean;
  data?: {
    conflict?: boolean;
    version?: number;
    blocked?: BlockedChannel[];
    whitelisted?: WhitelistedChannel[];
    message?: string;
    code?: string;
  };
}

export interface SettingsPushResponse {
  success: boolean;
  data?: {
    message?: string;
    code?: string;
  };
}

export interface SettingsPullResponse {
  success: boolean;
  data?: {
    changed?: false;
    blocked_channels?: BlockedChannel[] | null;
    whitelisted_channels?: WhitelistedChannel[] | null;
    spotify_content_types?: string[] | null;
    updated_at?: string | null;
    color_theme?: string;
    hub_background_enabled?: boolean;
    hide_non_japanese?: boolean;
    track_japanese_only?: boolean;
    daily_goal?: number;
    target_start_times?: (string | null)[] | null;
    message?: string;
    code?: string;
  };
}

export type ExtensionMessage =
  | { type: 'VIDEO_PLAY'; platform: Platform; state: VideoState; tabId?: number }
  | { type: 'VIDEO_PAUSE'; platform: Platform }
  | { type: 'VIDEO_ENDED'; platform: Platform; state?: VideoState }
  | { type: 'AD_START'; platform: Platform }
  | { type: 'AD_END'; platform: Platform }
  | { type: 'VIDEO_STATE_UPDATE'; platform: Platform; state: VideoState }
  | { type: 'TIME_DELTA'; platform: Platform; deltaMs: number; sessionId: string }
  | { type: 'JP343_SITE_LOADED'; userState: JP343UserState; displayName?: string }
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
  | { type: 'UPDATE_SETTINGS'; settings: ExtensionSettings }
  | { type: 'BLOCK_CHANNEL'; channel: BlockedChannel }
  | { type: 'UNBLOCK_CHANNEL'; channelId: string }
  | { type: 'WHITELIST_CHANNEL'; channel: WhitelistedChannel }
  | { type: 'UNWHITELIST_CHANNEL'; channelId: string }
  | { type: 'GET_CURRENT_CHANNEL' }
  | { type: 'UPDATE_SESSION_TITLE'; title: string }
  | { type: 'UPDATE_PENDING_ENTRY_TITLE'; entryId: string; title: string }
  | { type: 'MANUAL_TRACK_START'; title: string; url: string; tabId: number; activityType: ActivityType }
  | { type: 'GET_ACTIVE_TAB_INFO' }
  | { type: 'GET_STATS' }
  | { type: 'RESET_STATS' }
  | { type: 'SYNC_ENTRIES_DIRECT' }
  | { type: 'OPEN_DASHBOARD' }
  | { type: 'DIAGNOSTIC_EVENT'; code: string; platform?: Platform }
  | { type: 'GET_DIAGNOSTICS' }
  | { type: 'REFETCH_AVATAR' }
  | { type: 'PULL_CHANNELS' }
  | { type: 'GET_ANKI_STATE' }
  | { type: 'SET_ANKI_ENABLED'; enabled: boolean }
  | { type: 'ANKI_SYNC_NOW' }
  | { type: 'GET_ANKI_DECKS' }
  | { type: 'SET_ANKI_DECKS'; decks: string[] }
  | { type: 'ANKI_FLUSH_AND_RESET' }
  | { type: 'ANKI_RESET' }
  | { type: 'MOKURO_SYNC'; volumes: Record<string, MokuroVolumeSnapshot> }
  | { type: 'SET_MOKURO_ENABLED'; enabled: boolean }
  | { type: 'GET_MOKURO_STATE' }
  | { type: 'GET_DIFFICULTY_MAP' }
  | { type: 'SAVE_LOCAL_DIFFICULTY_BAND'; videoId: string; seed: DifficultySeed | null; source: string | null; methodVersion: string; channelKey: string | null }
  | { type: 'GET_VOTE_STATE'; channelId: string | null; channelName: string | null; channelUrl: string | null }
  | { type: 'SUBMIT_DIFFICULTY_VOTE'; channelId: string | null; channelName: string | null; channelUrl: string | null; videoId: string | null; level: number | null; mixed: boolean; choice: string; shownLevel: number };

export interface DirectSyncResult {
  attempted: number;
  succeeded: number;
  failed: number;
  noAuth: boolean;
  nonceMissing: boolean;
}

export interface BatchEntryResult {
  success: boolean;
  session_id: string | null;
  entry_id: number | null;
  duplicate: boolean;
  error: string | null;
  error_code: string | null;
}

export interface BatchSyncResponse {
  results: BatchEntryResult[];
  synced: number;
  duplicates: number;
  failed: number;
}

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
  hourlyMinutes?: Record<string, number>;
  readingDailyMinutes?: Record<string, number>;
}

export const DEFAULT_STATS: ExtensionStats = {
  totalMinutes: 0,
  dailyMinutes: {},
  lastActiveDate: '',
  currentStreak: 0,
  hourlyMinutes: {},
  readingDailyMinutes: {}
};

export type AnkiStatus = 'idle' | 'connected' | 'unreachable' | 'permission_needed' | 'api_key_required' | 'error';

export interface AnkiDay {
  seconds: number;
  reviews: number;
  newCards: number;
  reviewPass: number;
  reviewTotal: number;
  maturePass: number;
  matureTotal: number;
  learn: number;
  review: number;
  relearn: number;
  cram: number;
  colMature?: number;   // snapshot days only
  colYoung?: number;
  colNew?: number;
}

export interface AnkiCollectionState {
  lastSyncId: number;
  backfillDone: boolean;
  days: Record<string, AnkiDay>;
  seenCardIds: number[];
  dirtyDays: string[];
  lastPushedAt: number | null;
  lastPushError?: string | null;
}

export interface AnkiState {
  schemaVersion: number;
  enabled: boolean;
  selectedDecks: string[];
  status: AnkiStatus;
  lastSyncAt: number | null;
  activeCollection: string | null;
  collections: Record<string, AnkiCollectionState>;
  pendingServerReset?: boolean;
}

export const ANKI_SCHEMA_VERSION = 2;

export const DEFAULT_ANKI_STATE: AnkiState = {
  schemaVersion: ANKI_SCHEMA_VERSION,
  enabled: false,
  selectedDecks: [],
  status: 'idle',
  lastSyncAt: null,
  activeCollection: null,
  collections: {}
};

export interface MokuroVolumeSnapshot {
  effectiveMin: number;
  chars: number;
  currentPage: number;
  seriesTitle: string | null;
  volumeTitle: string | null;
  seriesUuid: string | null;
  completed: boolean;
  deleted: boolean;
}

export interface MokuroBaseline {
  lastEffectiveMin: number;
  lastChars: number;
  lastObservedAt: number;
}

export interface MokuroState {
  enabled: boolean;
  baselines: Record<string, MokuroBaseline>;
  creditedByDay: Record<string, number>;
  lastSyncAt: number | null;
  totalMinutes: number;
  totalChars: number;
}

export const DEFAULT_MOKURO_STATE: MokuroState = {
  enabled: false,
  baselines: {},
  creditedByDay: {},
  lastSyncAt: null,
  totalMinutes: 0,
  totalChars: 0
};

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  autoSync: true,
  mergeSameDaySessions: true,
  minDurationMinutes: 1,
  enabledPlatforms: ['youtube', 'netflix', 'crunchyroll', 'primevideo', 'disneyplus', 'cijapanese', 'nihongojikan', 'spotify', 'twitch', 'asbplayer'],
  blockedChannels: [],
  spotifyContentTypes: ['podcast', 'music', 'audiobook'],
  dailyGoalMinutes: 60,
  dayStartHour: 0,
  hideNonJapanese: false,
  trackJapaneseOnly: false,
  whitelistedChannels: [],
  useOriginalTitles: false,
  diagnosticsEnabled: true,
  backgroundEnabled: false,
  backgroundOpacity: 75,
  colorTheme: 'magenta' as ColorTheme,
  targetStartTimes: [null, null, null, null, null, null, null],
  stretchGoalsEnabled: true,
  streakRiskNotification: false,
  showDifficultyLevels: true,
  difficultyLocalOnly: false,
  difficultyVotingEnabled: true,
  difficultyContribEnabled: false
};

export const STORAGE_KEYS = {
  PENDING: 'jp343_extension_pending',
  SESSION: 'jp343_extension_session',
  USER: 'jp343_extension_user',
  SETTINGS: 'jp343_extension_settings',
  STATS: 'jp343_extension_stats',
  DISPLAY_NAME: 'jp343_extension_display_name',
  CACHED_SERVER_STATS: 'jp343_cached_server_stats',
  DIAGNOSTICS: 'jp343_extension_diagnostics',
  BACKGROUND_IMAGE: 'jp343_extension_bg_image',
  BG_IMAGE_REVISION: 'jp343_bg_image_revision',
  ACTIVITY_PREFS: 'jp343_extension_activity_prefs',
  MIGRATED_HUB_BG: 'jp343_migrated_hub_bg_to_server',
  TITLE_CACHE: 'jp343_yt_title_cache',
  AVATAR_DATA: 'jp343_avatar_data',
  AVATAR_USER_ID: 'jp343_avatar_user_id',
  CHANNEL_SYNC: 'jp343_channel_sync',
  COLLAPSED_CARDS: 'jp343_collapsed_cards',
  AUTH_FAILURE_COUNT: 'jp343_auth_failure_count',
  CACHED_SERVER_SESSIONS: 'jp343_cached_server_sessions',
  POPUP_HEIGHT: 'jp343_popup_height',
  RELOGIN_REQUIRED: 'jp343_relogin_required',
  STREAK_RISK_NOTIF_DATE: 'jp343_streak_risk_notif_date',
  ANKI: 'jp343_extension_anki',
  MOKURO: 'jp343_extension_mokuro',
  DIFFICULTY_HOTSET: 'jp343_difficulty_hotset',
  DIFFICULTY_VIDEOSET: 'jp343_difficulty_videoset',
  DIFFICULTY_LOCAL: 'jp343_difficulty_local',
  DIFFICULTY_VOTE_STATE: 'jp343_difficulty_vote_state',
  INSTALL_ID: 'jp343_install_id',
  DIFFICULTY_CONTRIB_QUEUE: 'jp343_difficulty_contrib_queue'
} as const;

export interface CachedServerSession {
  id: number | string;
  title: string;
  platform: string;
  duration_min: number;
  date: string;
  url?: string;
  thumbnail?: string;
  activityType?: string;
}

export interface PlatformHealth {
  contentScriptLoaded: number;
  playerFound: number;
  playerMissing: number;
  metadataFound: number;
  metadataMissing: number;
  videoPlaySent: number;
  heartbeatResume: number;
  adStateRecovered: number;
  sessionDiscarded: number;
  unflushedCollected: number;
  unflushedFailed: number;
  pauseDebounced: number;
  sessionIdRetry: number;
}

export interface SyncHealth {
  lastSuccess: string | null;
  lastFailure: string | null;
  consecutiveFailures: number;
}

export interface DiagnosticError {
  code: string;
  timestamp: string;
  platform?: Platform;
}

export interface ExtensionDiagnostics {
  schemaVersion: 1;
  extensionVersion: string;
  lastBackgroundStartup: string | null;
  serviceWorkerRestarts: number;
  platformHealth: Partial<Record<Platform, PlatformHealth>>;
  syncHealth: SyncHealth;
  recentErrors: DiagnosticError[];
  lastReportSent: string | null;
}

export const DEFAULT_DIAGNOSTICS: ExtensionDiagnostics = {
  schemaVersion: 1,
  extensionVersion: '',
  lastBackgroundStartup: null,
  serviceWorkerRestarts: 0,
  platformHealth: {},
  syncHealth: {
    lastSuccess: null,
    lastFailure: null,
    consecutiveFailures: 0
  },
  recentErrors: [],
  lastReportSent: null
};

export const DEFAULT_PLATFORM_HEALTH: PlatformHealth = {
  contentScriptLoaded: 0,
  playerFound: 0,
  playerMissing: 0,
  metadataFound: 0,
  metadataMissing: 0,
  videoPlaySent: 0,
  heartbeatResume: 0,
  adStateRecovered: 0,
  sessionDiscarded: 0,
  unflushedCollected: 0,
  unflushedFailed: 0,
  pauseDebounced: 0,
  sessionIdRetry: 0
};
