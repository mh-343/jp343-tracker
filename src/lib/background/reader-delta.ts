import type { ReaderBaseline, ReaderVolumeSnapshot } from '../../types';

export interface ReaderDelta {
  minutes: number;
  chars: number;
  baseline: ReaderBaseline;
}

// mokuro only: restart archives a pass, unread zeroes it
function restarted(baseline: ReaderBaseline, vol: ReaderVolumeSnapshot): boolean {
  if (vol.restarts === undefined) return false;
  if (vol.restarts > (baseline.restarts ?? vol.restarts)) return true;
  return vol.currentPage === 0 && vol.chars === 0;
}

// chars count once, above the highest point seen
export function readerDelta(baseline: ReaderBaseline | undefined, vol: ReaderVolumeSnapshot, now: number): ReaderDelta {
  const restarts = vol.restarts === undefined ? undefined : Math.max(vol.restarts, baseline?.restarts ?? 0);
  const next: ReaderBaseline = {
    lastEffectiveMin: vol.effectiveMin,
    lastChars: vol.chars,
    maxChars: vol.chars,
    ...(restarts === undefined ? {} : { restarts }),
    lastObservedAt: now
  };
  // first sight or reset time: rebase only
  if (!baseline || vol.effectiveMin < baseline.lastEffectiveMin) return { minutes: 0, chars: 0, baseline: next };

  const high = restarted(baseline, vol) ? 0 : (baseline.maxChars ?? baseline.lastChars);
  next.maxChars = Math.max(high, vol.chars);
  return {
    minutes: vol.effectiveMin - baseline.lastEffectiveMin,
    chars: Math.max(0, vol.chars - high),
    baseline: next
  };
}
