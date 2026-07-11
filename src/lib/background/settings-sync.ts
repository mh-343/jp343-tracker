import type {
  ExtensionSettings,
  JP343UserState,
  SettingsPullResponse,
  SpotifyContentType,
  ColorTheme,
} from '../../types';
import { STORAGE_KEYS } from '../../types';
import { isAuthFailure } from '../auth-helpers';
import { VALID_COLOR_THEMES } from '../theme';

interface SettingsSyncDeps {
  log: (...args: unknown[]) => void;
  loadSettings: () => Promise<ExtensionSettings>;
  saveSettings: (settings: ExtensionSettings) => Promise<void>;
  pullChannelsFromServer: () => Promise<void>;
  onAuthFailure: () => Promise<void>;
  onAuthSuccess: () => Promise<void>;
}

let deps: SettingsSyncDeps = {
  log: () => {},
  loadSettings: () => Promise.reject(new Error('not initialized')),
  saveSettings: () => Promise.reject(new Error('not initialized')),
  pullChannelsFromServer: () => Promise.resolve(),
  onAuthFailure: () => Promise.resolve(),
  onAuthSuccess: () => Promise.resolve(),
};

export function normalizeTargetStartTimes(raw: unknown): (string | null)[] {
  const def: (string | null)[] = [null, null, null, null, null, null, null];
  if (!Array.isArray(raw) || raw.length !== 7) return def;
  return raw.map((v: unknown) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v)) ? v : null);
}

let settingsPullComplete = false;
let settingsLastUpdated = '';
let settingsLastPullTime = 0;
let settingsPullInFlight: Promise<boolean> | null = null;

export function initSettingsSyncCallbacks(callbacks: SettingsSyncDeps): void {
  deps = callbacks;
}

export async function getSettingsLastPullTime(): Promise<number> {
  if (settingsLastPullTime) return settingsLastPullTime;
  try {
    const result = await browser.storage.session.get(STORAGE_KEYS.SETTINGS_PULL_ATTEMPT);
    const stored: unknown = result[STORAGE_KEYS.SETTINGS_PULL_ATTEMPT];
    return typeof stored === 'number' ? stored : 0;
  } catch {
    return 0;
  }
}

// Stamp survives service worker restarts
function stampPullAttempt(): void {
  settingsLastPullTime = Date.now();
  try {
    browser.storage.session.set({ [STORAGE_KEYS.SETTINGS_PULL_ATTEMPT]: settingsLastPullTime }).catch(() => {});
  } catch { /* session storage unavailable */ }
}

export async function syncSettingsToServer(settings: ExtensionSettings): Promise<void> {
  if (!settingsPullComplete) return;
  const userState: JP343UserState | null = (
    await browser.storage.local.get(STORAGE_KEYS.USER)
  )[STORAGE_KEYS.USER] ?? null;
  if (!userState?.isLoggedIn || !userState?.extApiToken) return;

  const ajaxUrl = userState.ajaxUrl || 'https://jp343.com/wp-admin/admin-ajax.php';
  try {
    const pushParams: Record<string, string> = {
      action: 'jp343_extension_push_settings',
      ext_api_token: userState.extApiToken,
      extension_version: browser.runtime.getManifest().version,
      spotify_content_types: JSON.stringify(settings.spotifyContentTypes),
      day_boundary_hour: String(settings.dayStartHour || 0),
      color_theme: settings.colorTheme ?? 'magenta',
      hide_non_japanese: String(settings.hideNonJapanese ?? false),
      track_japanese_only: String(settings.trackJapaneseOnly ?? true),
      daily_goal_minutes: String(settings.dailyGoalMinutes || 60),
      target_start_times: JSON.stringify(settings.targetStartTimes ?? [null, null, null, null, null, null, null]),
    };
    const controller = new AbortController();
    const pushTimeout = setTimeout(() => controller.abort(), 10000);
    let resp: Response;
    try {
      resp = await fetch(ajaxUrl, {
        method: 'POST',
        signal: controller.signal,
        body: new URLSearchParams(pushParams),
      });
    } finally {
      clearTimeout(pushTimeout);
    }
    if (!resp.ok) {
      deps.log('[JP343] Settings push HTTP error:', resp.status);
      return;
    }
    const result: { success: boolean; data?: { message?: string; code?: string } } = await resp.json();
    if (result.success) {
      deps.log('[JP343] Settings pushed to server');
      await deps.onAuthSuccess();
    } else {
      if (isAuthFailure(result)) {
        await deps.onAuthFailure();
        return;
      }
      deps.log('[JP343] Settings push failed:', result.data?.message);
    }
  } catch (error) {
    deps.log('[JP343] Settings push error:', error);
  }
}

export function pullAndMergeSettingsFromServer(): Promise<boolean> {
  if (!settingsPullInFlight) {
    settingsPullInFlight = doPullAndMergeSettings().finally(() => {
      settingsPullInFlight = null;
    });
  }
  return settingsPullInFlight;
}

async function doPullAndMergeSettings(): Promise<boolean> {
  // Stamp attempts so failed pulls throttle
  stampPullAttempt();

  const userState: JP343UserState | null = (
    await browser.storage.local.get(STORAGE_KEYS.USER)
  )[STORAGE_KEYS.USER] ?? null;
  if (!userState?.isLoggedIn || !userState?.extApiToken) {
    settingsPullComplete = true;
    return false;
  }

  const ajaxUrl = userState.ajaxUrl || 'https://jp343.com/wp-admin/admin-ajax.php';
  try {
    const params: Record<string, string> = {
      action: 'jp343_extension_pull_settings',
      ext_api_token: userState.extApiToken,
    };
    if (settingsLastUpdated) params.since = settingsLastUpdated;

    const controller = new AbortController();
    const pullTimeout = setTimeout(() => controller.abort(), 15000);
    let resp: Response;
    try {
      resp = await fetch(ajaxUrl, {
        method: 'POST',
        signal: controller.signal,
        body: new URLSearchParams(params),
      });
    } finally {
      clearTimeout(pullTimeout);
    }
    if (!resp.ok) {
      deps.log('[JP343] Settings pull HTTP error:', resp.status);
      return false;
    }
    const result: SettingsPullResponse = await resp.json();
    if (!result.success) {
      if (isAuthFailure(result)) {
        await deps.onAuthFailure();
        return false;
      }
      deps.log('[JP343] Settings pull failed:', result.data?.message);
      return false;
    }

    await deps.onAuthSuccess();

    if (result.data?.changed === false) {
      deps.log('[JP343] Settings unchanged on server, merging meta fields');
    }

    if (result.data?.updated_at) settingsLastUpdated = result.data.updated_at;

    const serverSpotify: SpotifyContentType[] | null = result.data?.spotify_content_types ?? null;
    const serverColorTheme: string | undefined = result.data?.color_theme;
    const serverHideNonJp: boolean | undefined = result.data?.hide_non_japanese;
    const serverTrackJpOnly: boolean | undefined = result.data?.track_japanese_only;
    const serverDailyGoal: number | undefined = result.data?.daily_goal;

    const settings = await deps.loadSettings();
    let changed = false;

    if (serverSpotify !== null) {
      const localStr = [...settings.spotifyContentTypes].sort().join(',');
      const serverStr = [...serverSpotify].sort().join(',');
      if (localStr !== serverStr) {
        settings.spotifyContentTypes = serverSpotify as SpotifyContentType[];
        changed = true;
      }
    }

    if (serverColorTheme && VALID_COLOR_THEMES.includes(serverColorTheme as ColorTheme)) {
      if (settings.colorTheme !== serverColorTheme) {
        settings.colorTheme = serverColorTheme as ColorTheme;
        changed = true;
      }
    }

    if (serverHideNonJp !== undefined && settings.hideNonJapanese !== serverHideNonJp) {
      settings.hideNonJapanese = serverHideNonJp;
      changed = true;
    }
    if (serverTrackJpOnly !== undefined && settings.trackJapaneseOnly !== serverTrackJpOnly) {
      settings.trackJapaneseOnly = serverTrackJpOnly;
      changed = true;
    }
    if (serverDailyGoal !== undefined && serverDailyGoal > 0 && settings.dailyGoalMinutes !== serverDailyGoal) {
      settings.dailyGoalMinutes = serverDailyGoal;
      changed = true;
    }
    const serverTargets = result.data?.target_start_times;
    if (serverTargets && Array.isArray(serverTargets) && serverTargets.length === 7) {
      if (JSON.stringify(settings.targetStartTimes ?? []) !== JSON.stringify(serverTargets)) {
        settings.targetStartTimes = normalizeTargetStartTimes(serverTargets);
        changed = true;
      }
    }

    if (changed) {
      await deps.saveSettings(settings);
      deps.log('[JP343] Settings merged from server');
    }
    settingsPullComplete = true;
    stampPullAttempt();

    deps.pullChannelsFromServer().catch(() => {});

    return serverColorTheme !== undefined;
  } catch (error) {
    deps.log('[JP343] Settings pull error:', error);
    return false;
  }
}
