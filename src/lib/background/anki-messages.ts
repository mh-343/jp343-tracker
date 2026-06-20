import type { ExtensionMessage } from '../../types';
import { getAnkiState, setAnkiEnabled, syncAnki, getAnkiDecks, setAnkiDecks, flushAndResetAnki, resetAnkiData } from './anki-sync';

export async function handleAnkiMessage(message: ExtensionMessage): Promise<unknown> {
  switch (message.type) {
    case 'GET_ANKI_STATE':
      return { success: true, data: { ankiState: await getAnkiState() } };
    case 'SET_ANKI_ENABLED':
      return { success: true, data: { ankiState: await setAnkiEnabled(message.enabled) } };
    case 'ANKI_SYNC_NOW':
      await syncAnki();
      return { success: true, data: { ankiState: await getAnkiState() } };
    case 'GET_ANKI_DECKS':
      return { success: true, data: await getAnkiDecks() };
    case 'SET_ANKI_DECKS':
      return { success: true, data: { ankiState: await setAnkiDecks(message.decks) } };
    case 'ANKI_FLUSH_AND_RESET':
      await flushAndResetAnki();
      return { success: true };
    case 'ANKI_RESET':
      return { success: true, data: { ankiState: await resetAnkiData() } };
    default:
      return { success: false, error: 'Unknown anki message' };
  }
}
