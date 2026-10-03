import type { Platform } from '../types';

// Website-only ids seen in server sessions
export type SitePlatform = 'reader' | 'podcast' | 'local_audio';
export type DisplayPlatform = Platform | SitePlatform;

export const PLATFORM_LABELS: Record<DisplayPlatform, string> = {
  youtube: 'YouTube',
  netflix: 'Netflix',
  crunchyroll: 'Crunchyroll',
  primevideo: 'Prime Video',
  disneyplus: 'Disney+',
  cijapanese: 'CI Japanese',
  nihongojikan: 'Nihongo no Jikan',
  spotify: 'Spotify',
  twitch: 'Twitch',
  asbplayer: 'asbplayer',
  mpchc: 'MPC-HC',
  mokuro: 'Mokuro',
  ttu: 'ttsu reader',
  generic: 'Custom sites',
  reader: 'jp343 Reader',
  podcast: 'Podcast',
  local_audio: 'Local audio'
};

export function platformLabel(id: string): string {
  return PLATFORM_LABELS[id as DisplayPlatform] || id;
}

export const PLATFORM_ICONS: Record<DisplayPlatform, string> = {
  youtube: '▶',
  netflix: 'N',
  crunchyroll: 'C',
  primevideo: 'P',
  disneyplus: 'D',
  cijapanese: '漢',
  nihongojikan: '時',
  spotify: '♪',
  twitch: 'T',
  asbplayer: 'A',
  mpchc: '▶',
  mokuro: '本',
  ttu: '📗',
  generic: '⏵',
  reader: '読',
  podcast: '🎙',
  local_audio: '🎧'
};
