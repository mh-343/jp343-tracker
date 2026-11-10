import type { ExtensionSettings, Platform } from '../types';

const PLATFORM_URL_PATTERNS: [Platform, RegExp][] = [
  ['youtube', /youtube\.com/],
  ['netflix', /netflix\.com/],
  ['crunchyroll', /crunchyroll\.com/],
  ['primevideo', /primevideo\.com/],
  ['primevideo', /amazon\.\w+.*\/gp\/video/],
  ['disneyplus', /disneyplus\.com/],
  ['cijapanese', /cijapanese\.com/],
  ['cijapanese', /nijapanese\.com/],
  ['nihongojikan', /nihongo-jikan\.com/],
  ['spotify', /open\.spotify\.com/],
  ['twitch', /twitch\.tv/],
  ['asbplayer', /app\.asbplayer\.dev/]
];

// off list, so new platforms start on
export function isPlatformDisabled(
  settings: Pick<ExtensionSettings, 'disabledPlatforms'>,
  platform: Platform
): boolean {
  const off = settings.disabledPlatforms;
  return Array.isArray(off) && off.includes(platform);
}

export function platformForUrl(url: string): Platform | null {
  return PLATFORM_URL_PATTERNS.find(([, pattern]) => pattern.test(url))?.[0] ?? null;
}
