import type { ExtensionSettings, Platform } from '../types';

export function isYoutubeMusicSignal(platform: Platform | string, ytCategory: string | null | undefined): boolean {
  return platform === 'youtube' && ytCategory === 'music';
}

export function musicTrackingAllowed(settings: ExtensionSettings): boolean {
  return settings.trackYoutubeMusic === true;
}

export function shouldSkipYoutubeMusic(source: { platform: Platform | string; ytCategory?: string | null }, settings: ExtensionSettings): boolean {
  return isYoutubeMusicSignal(source.platform, source.ytCategory) && !musicTrackingAllowed(settings);
}
