import type { ActivityType, AttentionCounters, AttentionHold, AttentionMode, AttentionSample } from '../types';
import { activityAllowsPassive } from '../types';

export function sampleAttention(): AttentionSample {
  if (document.visibilityState !== 'visible') return 'hidden';
  return document.hasFocus() ? 'focus' : 'visible';
}

// old content scripts send active/passive until reinject
export function normalizeAttentionSample(raw: unknown): AttentionSample | undefined {
  if (raw === 'focus' || raw === 'visible' || raw === 'hidden') return raw;
  if (raw === 'active') return 'focus';
  if (raw === 'passive') return 'hidden';
  return undefined;
}

export function normalizeIsPassive(raw: unknown): boolean | undefined {
  if (raw === 1 || raw === '1' || raw === true) return true;
  if (raw === 0 || raw === '0' || raw === false) return false;
  return undefined;
}

export function normalizePassiveShare(raw: unknown): number | undefined {
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

export function serverPassiveShare(row: { attention_passive_share?: unknown; is_passive?: unknown }): number | undefined {
  const share = normalizePassiveShare(row.attention_passive_share);
  if (share !== undefined) return share;
  const label = normalizeIsPassive(row.is_passive);
  if (label === undefined) return undefined;
  return label ? 1 : 0;
}

// focus lost this briefly counts as focus
export const ATTENTION_LOOKUP_GRACE_MS = 90_000;

export interface AttentionState {
  counters?: AttentionCounters;
  hold?: AttentionHold;
  last?: AttentionSample;
}

function bookHold(counters: AttentionCounters, hold: AttentionHold, toFocus: boolean): void {
  if (toFocus) {
    counters.focusMs += hold.visibleMs + hold.hiddenMs;
    return;
  }
  counters.visibleMs += hold.visibleMs;
  counters.hiddenMs += hold.hiddenMs;
}

export function accumulateAttention(state: AttentionState, sample: AttentionSample, deltaMs: number, now: number): AttentionState {
  const counters: AttentionCounters = { focusMs: 0, visibleMs: 0, hiddenMs: 0, ...state.counters };
  let hold: AttentionHold | undefined = state.hold ? { ...state.hold } : undefined;
  if (!(deltaMs > 0)) return { counters, hold, last: state.last };
  // a delta covers the time before its sample
  const deltaStart = now - deltaMs;
  if (hold && (sample === 'focus' || deltaStart - hold.since > ATTENTION_LOOKUP_GRACE_MS)) {
    bookHold(counters, hold, sample === 'focus' && deltaStart - hold.since <= ATTENTION_LOOKUP_GRACE_MS);
    hold = undefined;
  }
  if (sample === 'focus') {
    counters.focusMs += deltaMs;
    return { counters, last: sample };
  }
  if (!hold && state.last === 'focus') hold = { since: deltaStart, visibleMs: 0, hiddenMs: 0 };
  const bucket = sample === 'visible' ? 'visibleMs' : 'hiddenMs';
  if (hold) hold[bucket] += deltaMs;
  else counters[bucket] += deltaMs;
  return { counters, hold, last: sample };
}

// session end: focus did not come back
export function flushAttentionHold(state: AttentionState): AttentionState {
  if (!state.hold) return state;
  const counters: AttentionCounters = { focusMs: 0, visibleMs: 0, hiddenMs: 0, ...state.counters };
  bookHold(counters, state.hold, false);
  return { counters, last: state.last };
}

export interface AttentionShareInput {
  activityType?: ActivityType;
  isPassive?: boolean;
  attnFocusSec?: number;
  attnVisibleSec?: number;
  attnHiddenSec?: number;
  attentionChoice?: AttentionMode;
}

export function hasAttentionCounters(entry: AttentionShareInput): boolean {
  return (entry.attnFocusSec ?? 0) + (entry.attnVisibleSec ?? 0) + (entry.attnHiddenSec ?? 0) > 0;
}

// mirrors jp343_attention_passive_share_sql
export function passiveShare(entry: AttentionShareInput, visibleActive: boolean): number | null {
  const focus = entry.attnFocusSec ?? 0;
  const visible = entry.attnVisibleSec ?? 0;
  const hidden = entry.attnHiddenSec ?? 0;
  const sum = focus + visible + hidden;
  if (sum > 0) {
    if (!activityAllowsPassive(entry.activityType)) return 0;
    if (entry.attentionChoice) return entry.attentionChoice === 'passive' ? 1 : 0;
    return (hidden + (visibleActive ? 0 : visible)) / sum;
  }
  if (typeof entry.isPassive === 'boolean') return entry.isPassive ? 1 : 0;
  return null;
}

export function attentionMinutes(
  entry: AttentionShareInput & { duration_min: number },
  visibleActive: boolean
): { activeMin: number; passiveMin: number } | null {
  const share = passiveShare(entry, visibleActive);
  if (share === null) return null;
  return { activeMin: entry.duration_min * (1 - share), passiveMin: entry.duration_min * share };
}

export function attentionSecondsSplit(
  entry: AttentionShareInput & { duration_min: number },
  visibleActive: boolean
): { activeSec: number; passiveSec: number } | null {
  const minutes = attentionMinutes(entry, visibleActive);
  return minutes ? { activeSec: minutes.activeMin * 60, passiveSec: minutes.passiveMin * 60 } : null;
}

export function countersToEntryFields(counters: AttentionCounters | undefined): Pick<AttentionShareInput, 'attnFocusSec' | 'attnVisibleSec' | 'attnHiddenSec'> {
  if (!counters) return {};
  const attnFocusSec = Math.round(counters.focusMs / 1000);
  const attnVisibleSec = Math.round(counters.visibleMs / 1000);
  const attnHiddenSec = Math.round(counters.hiddenMs / 1000);
  if (attnFocusSec + attnVisibleSec + attnHiddenSec <= 0) return {};
  return { attnFocusSec, attnVisibleSec, attnHiddenSec };
}

// label for old readers: passive when focus is under half
export function focusMajorityIsPassive(entry: AttentionShareInput): boolean {
  const sum = (entry.attnFocusSec ?? 0) + (entry.attnVisibleSec ?? 0) + (entry.attnHiddenSec ?? 0);
  return sum > 0 && (entry.attnFocusSec ?? 0) / sum < 0.5;
}

export const ATTENTION_SHARE_MIN_TAGGED = 0.2;

// Same contract as website weekly ratio
export function computeAttentionShare(activeMin: number, passiveMin: number, totalMin: number, podcastMin = 0): number | null {
  const taggable = totalMin - podcastMin;
  if (taggable <= 0) return null;
  const tagged = Math.min(activeMin + passiveMin, taggable);
  if (tagged < ATTENTION_SHARE_MIN_TAGGED * taggable) return null;
  return Math.round((activeMin / (activeMin + passiveMin)) * 100);
}
