import type { ReaderSource } from '../../lib/reader-sources';

// user-gesture only
export function requestReaderPermission(source: ReaderSource): Promise<boolean> {
  try {
    return browser.permissions.request({ origins: source.origins });
  } catch {
    return Promise.resolve(false);
  }
}

export async function hasReaderPermission(source: ReaderSource): Promise<boolean> {
  try {
    return await browser.permissions.contains({ origins: source.origins });
  } catch {
    return false;
  }
}
