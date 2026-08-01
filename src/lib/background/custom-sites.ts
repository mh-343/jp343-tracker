import type { CustomSitesState, CustomSite } from '../../types';
import { STORAGE_KEYS, DEFAULT_CUSTOM_SITES_STATE } from '../../types';
import { withStorageLock } from '../storage-lock';

const SCRIPT_ID = 'jp343-custom-sites';
export const CUSTOM_SITES_SCRIPT_JS = 'content-scripts/custom-sites.js';

const BUILTIN_HOST_SUFFIXES = [
  'youtube.com', 'netflix.com', 'crunchyroll.com', 'primevideo.com',
  'amazon.com', 'amazon.de', 'amazon.co.jp', 'amazon.com.br',
  'disneyplus.com', 'cijapanese.com', 'nijapanese.com', 'nihongo-jikan.com',
  'spotify.com', 'twitch.tv', 'asbplayer.dev', 'jp343.com', 'mokuro.app',
  'ttsu.app', 'ttu-ebook.web.app'
];

const DEBUG = import.meta.env.DEV;
const log = DEBUG ? console.log.bind(console) : (..._args: unknown[]) => {};

interface ReinjectTargetShape {
  matches: string[];
  file: string;
  allFrames: boolean;
}

interface Mv2ContentScripts {
  register: (opts: {
    matches: string[];
    js: { file: string }[];
    allFrames?: boolean;
    matchAboutBlank?: boolean;
    runAt?: string;
  }) => Promise<{ unregister: () => void }>;
}

interface Mv3ScriptRegistration {
  id: string;
  matches: string[];
  js: string[];
  allFrames: boolean;
  runAt: 'document_idle';
  persistAcrossSessions: boolean;
  matchOriginAsFallback?: boolean;
}

async function loadState(): Promise<CustomSitesState> {
  const res = await browser.storage.local.get(STORAGE_KEYS.CUSTOM_SITES);
  const stored = res[STORAGE_KEYS.CUSTOM_SITES] as CustomSitesState | undefined;
  if (!stored) return { ...DEFAULT_CUSTOM_SITES_STATE, sites: [], names: {} };
  return { ...DEFAULT_CUSTOM_SITES_STATE, ...stored, names: { ...(stored.names ?? {}) } };
}

async function saveState(state: CustomSitesState): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.CUSTOM_SITES]: state });
}

export async function getCustomSitesState(): Promise<CustomSitesState> {
  return loadState();
}

// first stored site host matching any url
export async function allowedCustomSiteHost(urls: Array<string | undefined>): Promise<string | null> {
  const state = await loadState();
  for (const url of urls) {
    if (!url) continue;
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { continue; }
    if (host.startsWith('www.')) host = host.slice(4);
    const site = state.sites.find(s => hostMatchesSite(host, s.host));
    if (site) return site.host;
  }
  return null;
}

export async function saveCustomSitesState(state: CustomSitesState): Promise<void> {
  return saveState(state);
}

export function customSiteOrigin(host: string): string {
  return 'https://*.' + host + '/*';
}

// pre-wildcard grant pattern
export function customSiteLegacyOrigin(host: string): string {
  return 'https://' + host + '/*';
}

function hostMatchesSite(host: string, siteHost: string): boolean {
  return host === siteHost || host.endsWith('.' + siteHost);
}

export async function grantedPatternForHost(host: string): Promise<string | null> {
  for (const pattern of [customSiteOrigin(host), customSiteLegacyOrigin(host)]) {
    try {
      if (await browser.permissions.contains({ origins: [pattern] })) return pattern;
    } catch { /* skipped */ }
  }
  return null;
}

function isBuiltinHost(host: string): boolean {
  return BUILTIN_HOST_SUFFIXES.some(s => host === s || host.endsWith('.' + s));
}

export interface NormalizedHost {
  ok: boolean;
  host?: string;
  error?: string;
}

export function normalizeHost(input: string): NormalizedHost {
  let raw = (input || '').trim();
  if (!raw) return { ok: false, error: 'Enter a website address' };
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'That is not a valid address' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'Only https sites can be added' };
  let host = url.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (host === 'localhost' || isIp || !host.includes('.')) {
    return { ok: false, error: 'That host is not supported' };
  }
  if (isBuiltinHost(host)) {
    return { ok: false, error: 'This site already has a built-in tracker' };
  }
  return { ok: true, host };
}

async function grantedMatches(): Promise<string[]> {
  const state = await loadState();
  const matches: string[] = [];
  for (const site of state.sites) {
    const pattern = await grantedPatternForHost(site.host);
    if (pattern) matches.push(pattern);
  }
  return matches;
}

let mv2Handle: { unregister: () => void } | null = null;

let syncChain: Promise<void> = Promise.resolve();

export function syncCustomSitesRegistration(): Promise<void> {
  const next = syncChain.then(runSyncRegistration, runSyncRegistration);
  syncChain = next.catch(() => {});
  return next;
}

async function runSyncRegistration(): Promise<void> {
  const matches = await grantedMatches();
  try {
    if (import.meta.env.MANIFEST_VERSION === 3) {
      try { await browser.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }); } catch { /* not registered */ }
      if (matches.length > 0) {
        const script: Mv3ScriptRegistration = {
          id: SCRIPT_ID,
          matches,
          js: [CUSTOM_SITES_SCRIPT_JS],
          allFrames: true,
          runAt: 'document_idle',
          persistAcrossSessions: true
        };
        try {
          await browser.scripting.registerContentScripts([{ ...script, matchOriginAsFallback: true }]);
        } catch {
          // older Chrome rejects the property
          await browser.scripting.registerContentScripts([script]);
        }
      }
    } else {
      if (mv2Handle) { mv2Handle.unregister(); mv2Handle = null; }
      const mv2Api = (browser as unknown as { contentScripts?: Mv2ContentScripts }).contentScripts;
      if (mv2Api && matches.length > 0) {
        mv2Handle = await mv2Api.register({
          matches,
          js: [{ file: CUSTOM_SITES_SCRIPT_JS }],
          allFrames: true,
          matchAboutBlank: true,
          runAt: 'document_idle'
        });
      }
    }
  } catch (error) {
    log('[JP343][custom-sites] register failed', error);
  }
}

export async function getCustomSitesReinjectTargets(): Promise<ReinjectTargetShape[]> {
  const matches = await grantedMatches();
  if (matches.length === 0) return [];
  return [{ matches, file: CUSTOM_SITES_SCRIPT_JS, allFrames: true }];
}

export async function addCustomSite(host: string): Promise<{ ok: boolean; error?: string; site?: CustomSite }> {
  const norm = normalizeHost(host);
  if (!norm.ok || !norm.host) return { ok: false, error: norm.error };
  const cleanHost = norm.host;
  let site: CustomSite | undefined;
  await withStorageLock(async () => {
    const state = await loadState();
    const found = state.sites.find(s => s.host === cleanHost);
    if (found) { site = found; return; }
    site = { id: crypto.randomUUID(), host: cleanHost, addedAt: Date.now() };
    state.sites.push(site);
    await saveState(state);
  });
  await syncCustomSitesRegistration();
  return { ok: true, site };
}

export async function removeCustomSite(id: string): Promise<string | null> {
  let removedHost: string | null = null;
  await withStorageLock(async () => {
    const state = await loadState();
    const site = state.sites.find(s => s.id === id);
    if (!site) return;
    removedHost = site.host;
    state.sites = state.sites.filter(s => s.id !== id);
    for (const [videoId, name] of Object.entries(state.names)) {
      const host = name.host.startsWith('www.') ? name.host.slice(4) : name.host;
      if (host === removedHost) delete state.names[videoId];
    }
    await saveState(state);
  });
  await syncCustomSitesRegistration();
  if (removedHost) {
    for (const origin of [customSiteOrigin(removedHost), customSiteLegacyOrigin(removedHost)]) {
      try {
        await browser.permissions.remove({ origins: [origin] });
      } catch { /* skipped */ }
    }
  }
  return removedHost;
}

export function originsIncludeHost(origins: string[], host: string): boolean {
  return origins.some(origin => {
    const patternHost = origin.replace(/^https:\/\/(\*\.)?/, '').replace(/\/\*$/, '');
    return patternHost !== '' && hostMatchesSite(host, patternHost);
  });
}
