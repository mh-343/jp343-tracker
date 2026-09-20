import type { Platform } from '../types';

export const PLATFORM_LABELS: Record<Platform, string> = {
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
  ttu: 'ttu reader',
  generic: 'Generic'
};

export const PLATFORM_ICONS: Record<Platform, string> = {
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
  generic: '⏵'
};
