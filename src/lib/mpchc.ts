export const MPCHC_ORIGINS = [
  'http://localhost:13579/*',
  'http://127.0.0.1:13579/*',
];

export interface MpchcSnapshot {
  file: string;
  state: 0 | 1 | 2;
  position: number;
}

export interface MpchcSession {
  id: string;
  file: string;
  startedAt: number;
  accumulatedMs: number;
  lastPollAt: number;
  lastPosition: number;
  lastPlaying: boolean;
  idleSince: number | null;
}

export type MpchcStatus = 'off' | 'idle' | 'playing' | 'paused' | 'unreachable' | 'error' | 'permission_needed' | 'unsupported';

export interface MpchcState {
  enabled: boolean;
  session: MpchcSession | null;
  status: MpchcStatus;
  failures: number;
  outbox: import('../types').PendingEntry | null;
}

export function emptyMpchcState(): MpchcState {
  return { enabled: false, session: null, status: 'off', failures: 0, outbox: null };
}
