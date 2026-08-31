import type { AttentionMode } from '../../types';
import { activityAllowsPassive } from '../../types';
import { tracker } from '../time-tracker';
import type { BackgroundMessageContext } from './message-context';

const ATTENTION_STABLE_MS = 20_000;
const ATTENTION_MIN_SEGMENT_MS = 60_000;

export async function applyAttentionSample(
  rawSample: unknown,
  context: BackgroundMessageContext,
  recordDiagnostic?: (code: string, platform?: string) => void
): Promise<void> {
  if (rawSample !== 'active' && rawSample !== 'passive') return;
  const sample: AttentionMode = rawSample;
  const session = tracker.getCurrentSession();
  if (!session || session.attentionOverride) return;
  if (!activityAllowsPassive(session.activityType)) {
    // reading and speaking are structurally active
    session.attention = 'active';
    return;
  }
  if (session.attention === undefined) {
    session.attention = sample;
    return;
  }
  if (sample === session.attention) {
    session.attentionCandidate = undefined;
    session.attentionCandidateSince = undefined;
    return;
  }
  const now = Date.now();
  if (session.attentionCandidate !== sample || session.attentionCandidateSince === undefined) {
    session.attentionCandidate = sample;
    session.attentionCandidateSince = now;
    return;
  }
  if (now - session.attentionCandidateSince < ATTENTION_STABLE_MS) return;
  session.attentionCandidate = undefined;
  session.attentionCandidateSince = undefined;
  if (session.accumulatedMs < ATTENTION_MIN_SEGMENT_MS) {
    // short head segment keeps one entry
    session.attention = sample;
    return;
  }
  const platform = session.platform;
  const entry = tracker.splitSession(sample);
  if (entry) {
    await context.savePendingEntry(entry);
    recordDiagnostic?.('attention_split', platform);
  }
}
