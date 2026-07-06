// Difficulty chip + map state

import { STORAGE_KEYS } from '../../types';
import { showDifficultyChip, hideDifficultyChip } from '../../lib/difficulty-chip';
import { parseTitleLevel } from '../../lib/difficulty-seeds';
import type { DifficultySeed, ChannelBounds } from '../../lib/difficulty-seeds';
import { estimateLocalBand, LOCAL_METHOD_VERSION } from '../../lib/difficulty-local/estimator';
import { acquireYoutubeTranscript } from './transcript';
import { readLocalBandCache } from './difficulty-cache';
import {
  startFeedBadges,
  stopFeedBadges,
  scheduleFeedBadgeSweep,
  lookupSeedInMap,
  lookupByChannel
} from './feed-badges';

export interface DifficultyDeps {
  getVideoId(): string | null;
  getVideoTitle(): string;
  getChannelInfo(): { id: string | null; name: string | null; url: string | null };
  sendMessage(type: string, data?: Record<string, unknown>): Promise<unknown>;
}

let deps: DifficultyDeps | null = null;
let difficultyEnabled = true;
let difficultyLocalOnly = false;
let difficultyMapLoaded = false;
let settingsApplied = false;
let difficultyMap: Record<string, DifficultySeed> | null = null;
let difficultyVideoMap: Record<string, DifficultySeed> | null = null;
let difficultyChannelBounds: Record<string, ChannelBounds> | null = null;
const localBandCache = new Map<string, { seed: DifficultySeed; source: string } | null>();
const localComputing = new Set<string>();

export function initDifficulty(d: DifficultyDeps): void {
  deps = d;
}

function resolveCardSeed(videoId: string | null, channelId: string | null, channelName: string | null): DifficultySeed | null {
  if (!difficultyEnabled) return null;
  if (videoId && difficultyVideoMap?.[videoId]) return difficultyVideoMap[videoId];
  return lookupSeedInMap(difficultyMap, channelId, channelName);
}

async function loadDifficultyMap(): Promise<void> {
  if (!deps) return;
  if (difficultyLocalOnly) {
    difficultyMap = null;
    difficultyVideoMap = null;
    difficultyChannelBounds = null;
    difficultyMapLoaded = true;
    updateDifficultyChip();
    scheduleFeedBadgeSweep();
    return;
  }
  const response = await deps.sendMessage('GET_DIFFICULTY_MAP');
  const data = response as {
    channels?: Record<string, DifficultySeed> | null;
    videos?: Record<string, DifficultySeed> | null;
    channelBounds?: Record<string, ChannelBounds> | null;
  } | undefined;
  difficultyMap = data?.channels ?? null;
  difficultyVideoMap = data?.videos ?? null;
  difficultyChannelBounds = data?.channelBounds ?? null;
  difficultyMapLoaded = true;
  updateDifficultyChip();
  scheduleFeedBadgeSweep();
}

async function loadLocalBandCache(): Promise<void> {
  const cached = await readLocalBandCache(LOCAL_METHOD_VERSION);
  if (!cached) return;
  for (const [id, band] of Object.entries(cached)) {
    if (!localBandCache.has(id)) localBandCache.set(id, band);
  }
  updateDifficultyChip();
}

async function computeAndApplyLocalEstimate(videoId: string, channelId: string | null, channelName: string | null): Promise<void> {
  if (!deps) return;
  if (localBandCache.has(videoId) || localComputing.has(videoId)) return;
  localComputing.add(videoId);
  try {
    const transcript = await acquireYoutubeTranscript(videoId);
    if (deps.getVideoId() !== videoId) return;
    let result: { seed: DifficultySeed; source: string } | null = null;
    if (transcript) {
      const bounds = lookupByChannel(difficultyChannelBounds, channelId, channelName);
      const estimate = estimateLocalBand({
        json3: transcript.json3,
        title: deps.getVideoTitle(),
        durationSec: transcript.lengthSeconds,
        channelBounds: bounds
      });
      if (estimate) {
        result = { seed: estimate.seed, source: estimate.clamped ? 'local estimate (in band)' : 'local estimate' };
      }
    }
    localBandCache.set(videoId, result);
    void deps.sendMessage('SAVE_LOCAL_DIFFICULTY_BAND', { videoId, seed: result?.seed ?? null, source: result?.source ?? null, methodVersion: LOCAL_METHOD_VERSION });
    if (deps.getVideoId() === videoId) updateDifficultyChip();
  } finally {
    localComputing.delete(videoId);
  }
}

export function updateDifficultyChip(): void {
  if (!deps) return;
  if (!difficultyEnabled || !window.location.pathname.includes('/watch')) { hideDifficultyChip(); return; }
  const fromTitle = parseTitleLevel(deps.getVideoTitle());
  if (fromTitle) { showDifficultyChip(fromTitle, 'title tag'); return; }
  const videoId = deps.getVideoId();
  const videoSeed = videoId ? difficultyVideoMap?.[videoId] : null;
  if (videoSeed) { showDifficultyChip(videoSeed, 'video estimate'); return; }
  if (!difficultyMapLoaded && !difficultyLocalOnly) return;
  const channelInfo = deps.getChannelInfo();
  const cachedLocal = videoId ? localBandCache.get(videoId) : undefined;
  if (cachedLocal) { showDifficultyChip(cachedLocal.seed, cachedLocal.source); return; }
  const serverSeed = lookupSeedInMap(difficultyMap, channelInfo.id, channelInfo.name);
  if (serverSeed) showDifficultyChip(serverSeed, 'channel estimate');
  else hideDifficultyChip();
  if (videoId && cachedLocal === undefined) {
    void computeAndApplyLocalEstimate(videoId, channelInfo.id, channelInfo.name);
  }
}

export function applyDifficultySettings(enabled: boolean, localOnly: boolean): void {
  const prevEnabled = difficultyEnabled;
  const prevLocalOnly = difficultyLocalOnly;
  const first = !settingsApplied;
  settingsApplied = true;
  difficultyEnabled = enabled;
  difficultyLocalOnly = localOnly;
  if (enabled && (first || !prevEnabled)) {
    startFeedBadges(resolveCardSeed);
    void loadLocalBandCache();
    void loadDifficultyMap();
    return;
  }
  if (!enabled && prevEnabled) {
    stopFeedBadges();
    hideDifficultyChip();
    return;
  }
  if (enabled && localOnly !== prevLocalOnly) {
    localBandCache.clear();
    void loadDifficultyMap();
  }
}

export function handleDifficultyStorageChange(changes: Record<string, unknown>): void {
  if ((changes[STORAGE_KEYS.DIFFICULTY_HOTSET] || changes[STORAGE_KEYS.DIFFICULTY_VIDEOSET]) && difficultyEnabled) {
    void loadDifficultyMap();
  }
}
