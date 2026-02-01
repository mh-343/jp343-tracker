// =============================================================================
// JP343 Extension - Type Definitionen
// =============================================================================

// Unterstuetzte Streaming-Plattformen
export type Platform = 'youtube' | 'netflix' | 'crunchyroll' | 'generic';

// Video-Status von Content Scripts
export interface VideoState {
  isPlaying: boolean;
  currentTime: number;       // Aktuelle Position in Sekunden
  duration: number;          // Gesamtdauer in Sekunden
  title: string;
  url: string;
  platform: Platform;
  isAd: boolean;             // Werbung erkannt?
  thumbnailUrl: string | null;
  videoId: string | null;    // Plattform-spezifische ID (z.B. YouTube video ID)
  // Channel-Informationen (fuer Projekt-Zuordnung)
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
  tabId: number | null;      // Browser Tab ID fuer Auto-Save bei Tab-Close
  startTime: number;         // Unix timestamp (ms)
  accumulatedMs: number;     // Getrackte Zeit (ohne Ads/Pausen)
  lastUpdate: number;        // Letztes Update timestamp
  isActive: boolean;         // Laeuft gerade?
  isPaused: boolean;         // Manuell pausiert?
  thumbnailUrl: string | null;
  // Channel-Informationen
  channelId: string | null;
  channelName: string | null;
  channelUrl: string | null;
}

// Pending Entry - wartet auf Sync mit JP343
export interface PendingEntry {
  id: string;
  date: string;              // ISO 8601
  duration_min: number;      // IMMER Minuten, minimum 1
  project: string;           // Anzeigename
  project_id: string;        // Technische ID
  platform: Platform;
  source: 'extension';
  url: string;
  thumbnail: string | null;
  synced: boolean;           // Erfolgreich zu JP343 gesynct?
  syncedAt: string | null;   // Wann gesynct (ISO 8601) - fuer Anzeige/Cleanup
  syncAttempts: number;      // Anzahl Sync-Versuche
  lastSyncError: string | null; // Letzter Fehler falls Sync fehlschlug
  // Channel-Informationen (fuer Projekt-Zuordnung auf Website)
  channelId: string | null;
  channelName: string | null;
  channelUrl: string | null;
}

// JP343-kompatibles Immersion Log Format
export interface JP343ImmersionLogEntry {
  id: string;
  date: string;
  duration_min: number;
  project: string;
  project_id: string;
  source: 'extension';
  note: string;
  resourceUrl: string;
  thumbnail: string | null;
  type: 'watching' | 'reading' | 'listening' | 'other';
  sessionId: string | null;
  // Channel-Informationen (fuer Website-seitige Zuordnung)
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

// Message-Typen zwischen Content Scripts und Background
export type ExtensionMessage =
  | { type: 'VIDEO_PLAY'; platform: Platform; state: VideoState; tabId?: number }
  | { type: 'VIDEO_PAUSE'; platform: Platform }
  | { type: 'VIDEO_ENDED'; platform: Platform }
  | { type: 'AD_START'; platform: Platform }
  | { type: 'AD_END'; platform: Platform }
  | { type: 'VIDEO_STATE_UPDATE'; platform: Platform; state: VideoState }
  | { type: 'JP343_SITE_LOADED'; userState: JP343UserState }
  | { type: 'JP343_INJECT_ENTRY'; entry: JP343ImmersionLogEntry }
  | { type: 'JP343_GET_USER_STATE' }
  | { type: 'GET_CURRENT_SESSION' }
  | { type: 'GET_PENDING_ENTRIES' }
  | { type: 'DELETE_PENDING_ENTRY'; entryId: string }
  | { type: 'MARK_ENTRY_SYNCED'; entryId: string }
  | { type: 'MARK_ENTRY_FAILED'; entryId: string; error: string }
  | { type: 'CLEAR_SYNCED_ENTRIES' }
  | { type: 'STOP_SESSION' }
  | { type: 'PAUSE_SESSION' }
  | { type: 'RESUME_SESSION' }
  | { type: 'SYNC_NOW' }
  | { type: 'GET_SETTINGS' }
  | { type: 'SET_ENABLED'; enabled: boolean }
  | { type: 'BLOCK_CHANNEL'; channel: BlockedChannel }
  | { type: 'UNBLOCK_CHANNEL'; channelId: string }
  | { type: 'GET_CURRENT_CHANNEL' };

// Response-Typen
export type ExtensionResponse =
  | { success: true; data?: unknown }
  | { success: false; error: string };

// Default Settings
export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  autoSync: true,
  minDurationMinutes: 1,
  enabledPlatforms: ['youtube', 'netflix'],
  showNotifications: true,
  blockedChannels: []
};
