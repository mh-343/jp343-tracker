// JP343 Extension - Type Definitionen

// Unterstuetzte Streaming-Plattformen
export type Platform = 'youtube' | 'netflix' | 'crunchyroll' | 'primevideo' | 'generic';

// Video-Status von Content Scripts
export interface VideoState {
  isPlaying: boolean;
  currentTime: number;       // Aktuelle Position in Sekunden
  duration: number;          // Gesamtdauer in Sekunden
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

// Aktive Tracking-Session
export interface TrackingSession {
  id: string;                // Format: ext_<timestamp>_<random>
  platform: Platform;
  title: string;
  url: string;
  videoId: string | null;
  tabId: number | null;
  startTime: number;         // Unix timestamp (ms)
  accumulatedMs: number;     // Getrackte Zeit (ohne Ads/Pausen)
  lastUpdate: number;        // Letztes Update timestamp
  isActive: boolean;         // Laeuft gerade?
  isPaused: boolean;         // Manuell pausiert?
  thumbnailUrl: string | null;
  titleManuallyEdited?: boolean;
  // Channel-Informationen
  channelId: string | null;
  channelName: string | null;
  channelUrl: string | null;
}

export interface PendingEntry {
  id: string;
  date: string;              // ISO 8601
  duration_min: number;
  project: string;           // Anzeigename
  project_id: string;        // Technische ID
  platform: Platform;
  source: 'extension';
  url: string;
  thumbnail: string | null;
  synced: boolean;           // Erfolgreich zu JP343 gesynct?
  syncedAt: string | null;
  syncAttempts: number;      // Anzahl Sync-Versuche
  lastSyncError: string | null; // Letzter Fehler falls Sync fehlschlug
  serverEntryId: number | null;
  channelId: string | null;
  channelName: string | null;
  channelUrl: string | null;
}

// JP343 User State (vom Content Script auf JP343-Seite)
export interface JP343UserState {
  isLoggedIn: boolean;
  userId: number | null;
  nonce: string | null;
  ajaxUrl: string | null;
  guestToken: string | null;
  extApiToken: string | null;
}

// Extension Storage Schema
export interface ExtensionStorage {
  // Pending entries waiting for sync
  jp343_extension_pending: PendingEntry[];

  // Current active session (if any)
  jp343_extension_session: TrackingSession | null;

  // Last known JP343 user state
  jp343_extension_user: JP343UserState | null;

  // Settings
  jp343_extension_settings: ExtensionSettings;

  // Lokale Stats (unabhaengig vom Sync)
  jp343_extension_stats: ExtensionStats;
}

export interface ExtensionSettings {
  enabled: boolean;           // Globaler On/Off Switch
  autoSync: boolean;          // Auto-sync beim JP343-Besuch
  minDurationMinutes: number; // Minimum Dauer (default: 1)
  enabledPlatforms: Platform[];
  showNotifications: boolean;
  blockedChannels: BlockedChannel[]; // Blockierte YouTube-Kanaele
}

// Blockierter Kanal
export interface BlockedChannel {
  channelId: string;
  channelName: string;
  channelUrl: string | null;
  blockedAt: string;          // ISO 8601
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
  | { type: 'MANUAL_TRACK_START'; title: string; url: string; tabId: number }
  | { type: 'GET_ACTIVE_TAB_INFO' }
  | { type: 'GET_STATS' }
  | { type: 'RESET_STATS' }
  | { type: 'SYNC_ENTRIES_DIRECT' }
  | { type: 'OPEN_DASHBOARD' };

export interface DirectSyncResult {
  attempted: number;
  succeeded: number;
  failed: number;
  noAuth: boolean;       // Kein Nonce vorhanden
  nonceMissing: boolean;
}

// Response-Typen
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
  totalMinutes: number;                    // Gesamtminuten je getrackt
  dailyMinutes: Record<string, number>;    // '2026-02-20' → 130
  lastActiveDate: string;                  // '2026-02-20'
  currentStreak: number;
}

export const DEFAULT_STATS: ExtensionStats = {
  totalMinutes: 0,
  dailyMinutes: {},
  lastActiveDate: '',
  currentStreak: 0
};

// Default Settings
export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  autoSync: true,
  minDurationMinutes: 1,
  enabledPlatforms: ['youtube', 'netflix', 'crunchyroll', 'primevideo'],
  showNotifications: true,
  blockedChannels: []
};
