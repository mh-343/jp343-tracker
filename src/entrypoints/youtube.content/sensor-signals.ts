// pure sensor derivations (BGM content sensors)
import type { AsrState } from '../../types';
import { isJapaneseLanguageCode } from '../../lib/language-detection';

export interface OriginalTitleDetail {
  title: string | null;
  videoId: string | null;
  audioLang?: string | null;
  desc?: string | null;
  author?: string | null;
  channelId?: string | null;
  category?: string | null;
  isLive?: boolean | null;
  responseRead?: boolean;
}

export function deriveAsrState(audioLang: string | null, responseRead: boolean): AsrState | null {
  if (audioLang) return isJapaneseLanguageCode(audioLang) ? 'ja' : 'other';
  return responseRead ? 'no_asr_track' : null;
}

export function mapYtCategory(raw: string | null): 'music' | 'other' | null {
  if (!raw) return null;
  return raw.trim().toLowerCase() === 'music' ? 'music' : 'other';
}
