import type { ExtensionMessage } from '../../types';
import { getMpchcState, setMpchcEnabled, pollMpchc } from './mpchc-poller';

export async function handleMpchcMessage(message: ExtensionMessage): Promise<unknown> {
  switch (message.type) {
    case 'GET_MPCHC_STATUS':
      return { success: true, data: await getMpchcState() };
    case 'SET_MPCHC_ENABLED':
      if (typeof message.enabled !== 'boolean') return { success: false, error: 'Invalid enabled value' };
      return { success: true, data: await setMpchcEnabled(message.enabled) };
    case 'MPCHC_PROBE':
      await pollMpchc();
      return { success: true, data: await getMpchcState() };
    default:
      return { success: false, error: 'Unknown player message' };
  }
}
