import type { PlayerLive } from '../mpchc';
import { getMpchcState, pollMpchc, mpchcPeriodMinutes } from './mpchc-poller';

const PROBE_MIN_GAP_MS = 5_000;
let lastProbeAt = 0;

export async function getPlayerLive(): Promise<PlayerLive | null> {
  const state = await getMpchcState();
  if (!state.enabled) return null;
  const now = Date.now();
  if (now - lastProbeAt > PROBE_MIN_GAP_MS) {
    lastProbeAt = now;
    void pollMpchc().catch(() => {});
  }
  const session = state.session;
  return {
    status: state.status,
    periodMs: mpchcPeriodMinutes() * 60_000,
    session: session ? {
      id: session.id, file: session.file, startedAt: session.startedAt,
      accumulatedMs: session.accumulatedMs, lastPollAt: session.lastPollAt, lastPlaying: session.lastPlaying,
    } : null,
  };
}
