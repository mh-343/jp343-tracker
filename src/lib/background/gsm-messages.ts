import type { ExtensionMessage } from '../../types';
import { getGsmState } from './gsm-connect';
import { getGsmImportStatus, previewGsmImport, startGsmImport } from './gsm-import';
import { setGsmEnabled, syncGsm } from './gsm-poller';

export async function handleGsmMessage(message: ExtensionMessage): Promise<unknown> {
  switch (message.type) {
    case 'GET_GSM_STATUS':
      return { success: true, data: await getGsmState() };
    case 'SET_GSM_ENABLED':
      if (typeof message.enabled !== 'boolean') return { success: false, error: 'Invalid enabled value' };
      return { success: true, data: await setGsmEnabled(message.enabled) };
    case 'GSM_SYNC_NOW':
      await syncGsm(false, true);
      return { success: true, data: await getGsmState() };
    case 'GSM_IMPORT_PREVIEW': {
      const result = await previewGsmImport();
      return result.ok ? { success: true, data: result.preview } : { success: false, error: result.error };
    }
    case 'GSM_IMPORT_START': {
      const result = await startGsmImport(message.games);
      return result.ok ? { success: true, data: result.counts } : { success: false, error: result.error };
    }
    case 'GET_GSM_IMPORT_STATUS':
      return { success: true, data: await getGsmImportStatus() };
    default:
      return { success: false, error: 'Unknown GSM message' };
  }
}
