import type { ExtensionSettings, Platform } from '../types';

// off list, so new platforms start on
export function isPlatformDisabled(
  settings: Pick<ExtensionSettings, 'disabledPlatforms'>,
  platform: Platform
): boolean {
  return (settings.disabledPlatforms ?? []).includes(platform);
}
