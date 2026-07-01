import type { ExtensionMessage } from '../../types';
import type { BackgroundMessageContext } from './message-context';
import { getMokuroState, setMokuroEnabled, ingestMokuroSnapshot } from './mokuro-sync';

export async function handleMokuroMessage(
  message: ExtensionMessage,
  ctx: BackgroundMessageContext
): Promise<unknown> {
  switch (message.type) {
    case 'GET_MOKURO_STATE':
      return { success: true, data: { mokuroState: await getMokuroState() } };
    case 'SET_MOKURO_ENABLED':
      return { success: true, data: { mokuroState: await setMokuroEnabled(message.enabled) } };
    case 'MOKURO_SYNC':
      await ingestMokuroSnapshot(message.volumes, ctx);
      return { success: true };
    default:
      return { success: false, error: 'Unknown mokuro message' };
  }
}
