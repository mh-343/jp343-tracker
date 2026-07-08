// Difficulty chip + map state

import { STORAGE_KEYS } from '../../types';
import { showDifficultyChip, hideDifficultyChip } from '../../lib/difficulty-chip';
import type { ChipVoteContext } from '../../lib/difficulty-chip';
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
let difficultyVotingEnabled = true;
let difficultyMapLoaded = false;
let settingsApplied = false;
let difficultyMap: Record<string, DifficultySeed> | null = null;
let difficultyVideoMap: Record<string, DifficultySeed> | null = null;
let difficultyChannelBounds: Record<string, ChannelBounds> | null = null;
const localBandCache = new Map<string, { seed: DifficultySeed; source: string } | null>();
const localComputing = new Set<string>();
let voteState: { eligible: boolean; vote: { level: number | null; mixed: boolean } | null } | null = null;
let voteStateKey: string | null = null;
let voteStateRequested: string | null = null;

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

function channelKeyOf(channelInfo: { id: string | null; name: string | null }): string | null {
  const raw = channelInfo.id || channelInfo.name;
  return raw ? raw.trim().toLowerCase() : null;
}

function resetVoteState(): void {
  voteState = null;
  voteStateKey = null;
  voteStateRequested = null;
}

function ensureVoteState(channelInfo: { id: string | null; name: string | null; url: string | null }): void {
  if (!deps) return;
  const key = channelKeyOf(channelInfo);
  if (!key || key === voteStateKey || key === voteStateRequested) return;
  voteStateRequested = key;
  void deps.sendMessage('GET_VOTE_STATE', { channelId: channelInfo.id, channelName: channelInfo.name, channelUrl: channelInfo.url })
    .then(response => {
      if (voteStateRequested !== key) return;
      voteStateRequested = null;
      voteStateKey = key;
      const data = response as { eligible?: boolean; vote?: { level: number | null; mixed: boolean } | null } | undefined;
      voteState = data ? { eligible: data.eligible ?? false, vote: data.vote ?? null } : null;
      if (voteState?.eligible) updateDifficultyChip();
    });
}

function voteContextFor(
  videoId: string | null,
  channelInfo: { id: string | null; name: string | null; url: string | null }
): ChipVoteContext | undefined {
  // local-only never hits the server
  if (!difficultyVotingEnabled || difficultyLocalOnly) return undefined;
  ensureVoteState(channelInfo);
  const key = channelKeyOf(channelInfo);
  if (!key || key !== voteStateKey || !voteState?.eligible) return undefined;
  const vote = voteState.vote;
  return {
    ownVote: vote,
    onVote: async (level, mixed, choice, shownLevel) => {
      if (!deps) return { ok: false };
      const response = await deps.sendMessage('SUBMIT_DIFFICULTY_VOTE', {
        channelId: channelInfo.id,
        channelName: channelInfo.name,
        channelUrl: channelInfo.url,
        videoId,
        level,
        mixed,
        choice,
        shownLevel
      });
      const result = response as { success?: boolean; message?: string } | undefined;
      if (result?.success) {
        voteState = { eligible: true, vote: { level, mixed } };
        return { ok: true };
      }
      return { ok: false, message: result?.message };
    }
  };
}

export function updateDifficultyChip(): void {
  if (!deps) return;
  if (!difficultyEnabled || !window.location.pathname.includes('/watch')) { hideDifficultyChip(); return; }
  const videoId = deps.getVideoId();
  const channelInfo = deps.getChannelInfo();
  const show = (seed: DifficultySeed, source: string): void => {
    showDifficultyChip(seed, source, voteContextFor(videoId, channelInfo));
  };
  const fromTitle = parseTitleLevel(deps.getVideoTitle());
  if (fromTitle) { show(fromTitle, 'title tag'); return; }
  const videoSeed = videoId ? difficultyVideoMap?.[videoId] : null;
  if (videoSeed) { show(videoSeed, 'video estimate'); return; }
  if (!difficultyMapLoaded && !difficultyLocalOnly) return;
  const cachedLocal = videoId ? localBandCache.get(videoId) : undefined;
  if (cachedLocal) { show(cachedLocal.seed, cachedLocal.source); return; }
  const serverSeed = lookupSeedInMap(difficultyMap, channelInfo.id, channelInfo.name);
  if (serverSeed) show(serverSeed, 'channel estimate');
  else hideDifficultyChip();
  if (videoId && cachedLocal === undefined) {
    void computeAndApplyLocalEstimate(videoId, channelInfo.id, channelInfo.name);
  }
}

export function applyDifficultySettings(enabled: boolean, localOnly: boolean, votingEnabled: boolean): void {
  const prevEnabled = difficultyEnabled;
  const prevLocalOnly = difficultyLocalOnly;
  const prevVoting = difficultyVotingEnabled;
  const first = !settingsApplied;
  settingsApplied = true;
  difficultyEnabled = enabled;
  difficultyLocalOnly = localOnly;
  difficultyVotingEnabled = votingEnabled;
  if (enabled && (first || !prevEnabled)) {
    startFeedBadges(resolveCardSeed);
    void loadLocalBandCache();
    void loadDifficultyMap();
    return;
  }
  if (!enabled && prevEnabled) {
    stopFeedBadges();
    hideDifficultyChip();
    resetVoteState();
    return;
  }
  if (enabled && localOnly !== prevLocalOnly) {
    localBandCache.clear();
    resetVoteState();
    void loadDifficultyMap();
  } else if (enabled && votingEnabled !== prevVoting) {
    updateDifficultyChip();
  }
}

export function handleDifficultyStorageChange(changes: Record<string, unknown>): void {
  if ((changes[STORAGE_KEYS.DIFFICULTY_HOTSET] || changes[STORAGE_KEYS.DIFFICULTY_VIDEOSET]) && difficultyEnabled) {
    void loadDifficultyMap();
  }
}
