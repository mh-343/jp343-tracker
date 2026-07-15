import type { Platform } from '../types';
import { STORAGE_KEYS } from '../types';

export interface ReaderSource {
  id: string;
  platform: Platform;
  label: string;
  icon: string;
  origins: string[];
  scriptId: string;
  scriptFile: string;
  stateKey: string;
  fallbackNameRe: RegExp;
  entryUrl: string;
}

export const READER_SOURCES: Record<'mokuro' | 'ttu', ReaderSource> = {
  mokuro: {
    id: 'mokuro',
    platform: 'mokuro',
    label: 'Mokuro',
    icon: '本',
    origins: ['*://reader.mokuro.app/*'],
    scriptId: 'mokuro-reader',
    scriptFile: 'content-scripts/mokuro.js',
    stateKey: STORAGE_KEYS.MOKURO,
    fallbackNameRe: /^Mokuro [0-9a-f]{8}$/i,
    entryUrl: 'https://reader.mokuro.app/'
  },
  ttu: {
    id: 'ttu',
    platform: 'ttu',
    label: 'ttu reader',
    icon: '📗',
    origins: ['*://reader.ttsu.app/*', '*://ttu-ebook.web.app/*'],
    scriptId: 'ttu-reader',
    scriptFile: 'content-scripts/ttu.js',
    stateKey: STORAGE_KEYS.TTU,
    fallbackNameRe: /^ttu reader [0-9a-f]{8}$/i,
    entryUrl: 'https://reader.ttsu.app/'
  }
};

export const READER_SOURCE_LIST: ReaderSource[] = Object.values(READER_SOURCES);

export function readerForPlatform(platform: Platform): ReaderSource | undefined {
  return READER_SOURCE_LIST.find(s => s.platform === platform);
}

// Hostname from a '*://host/*' pattern
export function readerOriginHost(origin: string): string {
  return origin.replace(/^\*:\/\//, '').replace(/\/\*$/, '');
}

export function readerSourceForOrigins(origins: string[] | undefined): ReaderSource | undefined {
  if (!origins?.length) return undefined;
  return READER_SOURCE_LIST.find(s => s.origins.some(o => origins.includes(o)));
}

export function readerSourceForHostname(hostname: string): ReaderSource | undefined {
  return READER_SOURCE_LIST.find(s => s.origins.some(o => readerOriginHost(o) === hostname));
}
