import type { ExtensionMessage } from '../../types';
import type { BackgroundMessageContext } from './message-context';
import { readerForPlatform } from '../reader-sources';
import { getReaderState, setReaderEnabled, ingestReaderSnapshot } from './reader-sync';

export async function handleReaderMessage(
  message: ExtensionMessage,
  ctx: BackgroundMessageContext
): Promise<unknown> {
  if (
    message.type !== 'READER_GET_STATE' &&
    message.type !== 'READER_SET_ENABLED' &&
    message.type !== 'READER_SNAPSHOT'
  ) {
    return { success: false, error: 'Unknown reader message' };
  }

  const source = readerForPlatform(message.source);
  if (!source) return { success: false, error: 'Unknown reader source' };

  switch (message.type) {
    case 'READER_GET_STATE':
      return { success: true, data: { readerState: await getReaderState(source) } };
    case 'READER_SET_ENABLED':
      return { success: true, data: { readerState: await setReaderEnabled(source, message.enabled) } };
    case 'READER_SNAPSHOT':
      await ingestReaderSnapshot(source, message.volumes, ctx);
      return { success: true };
    default:
      return { success: false, error: 'Unknown reader message' };
  }
}
