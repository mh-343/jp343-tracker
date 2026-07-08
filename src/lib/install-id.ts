import { STORAGE_KEYS } from '../types';

// device-local anonymous id (uuid v4)
export async function getInstallId(): Promise<string> {
  const result = await browser.storage.local.get(STORAGE_KEYS.INSTALL_ID);
  const existing = result[STORAGE_KEYS.INSTALL_ID];
  if (typeof existing === 'string' && existing) return existing;
  const id = crypto.randomUUID();
  await browser.storage.local.set({ [STORAGE_KEYS.INSTALL_ID]: id });
  return id;
}
