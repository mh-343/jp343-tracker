export const MOKURO_ORIGIN = '*://reader.mokuro.app/*';

// user-gesture only
export function requestMokuroPermission(): Promise<boolean> {
  try {
    return browser.permissions.request({ origins: [MOKURO_ORIGIN] });
  } catch {
    return Promise.resolve(false);
  }
}

export async function hasMokuroPermission(): Promise<boolean> {
  try {
    return await browser.permissions.contains({ origins: [MOKURO_ORIGIN] });
  } catch {
    return false;
  }
}
