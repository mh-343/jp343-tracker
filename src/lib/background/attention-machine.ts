import { activityAllowsPassive } from '../../types';
import { accumulateAttention, normalizeAttentionSample } from '../attention';
import { tracker } from '../time-tracker';

// counts a delta the tracker already accepted
export function applyAttentionSample(rawSample: unknown, deltaMs: number): void {
  const sample = normalizeAttentionSample(rawSample);
  if (!sample) return;
  const session = tracker.getCurrentSession();
  if (!session) return;
  if (!activityAllowsPassive(session.activityType)) {
    // reading and speaking are structurally active
    session.attention = 'active';
    return;
  }
  const next = accumulateAttention(
    { counters: session.attnCounters, hold: session.attnHold, last: session.attnLast },
    sample,
    deltaMs,
    Date.now()
  );
  session.attnCounters = next.counters;
  session.attnHold = next.hold;
  session.attnLast = next.last;
  session.attention = session.attentionOverride ?? (sample === 'focus' ? 'active' : 'passive');
}
