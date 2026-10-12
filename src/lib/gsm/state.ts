export const GSM_ORIGIN = 'http://127.0.0.1:7275';
export const GSM_ORIGINS = ['http://127.0.0.1:7275/*'];

export type GsmStatus =
  | 'off'
  | 'connecting'
  | 'ok'
  | 'local'
  | 'unreachable'
  | 'unsupported'
  | 'no_games'
  | 'too_many_games'
  | 'signed_out'
  | 'server_unavailable'
  | 'call_rejected'
  | 'permission_needed'
  | 'desktop_only';

export interface GsmState {
  enabled: boolean;
  // epoch seconds, UTC
  enabledAt: number | null;
  dbId: string | null;
  knownGameUuids: string[];
  // local YYYY-MM-DD, next day of the full pass
  fullCursor: string | null;
  lastHot: number | null;
  lastFull: number | null;
  status: GsmStatus;
  rejectedCount: number;
  oversizedDays: number;
  failures: number;
  // user with a full server pass
  serverOwner: number | null;
  // user being caught up
  catchUpOwner: number | null;
  // local day -> sessions the server leaves off the leaderboard
  lbExcluded: Record<string, number>;
  // last hot read the server has, epoch ms
  serverFingerprint: string | null;
  serverSentAt: number | null;
  serverTriedAt: number | null;
}

export function emptyGsmState(): GsmState {
  return {
    enabled: false, enabledAt: null, dbId: null, knownGameUuids: [], fullCursor: null,
    lastHot: null, lastFull: null, status: 'off', rejectedCount: 0, oversizedDays: 0, failures: 0,
    serverOwner: null, catchUpOwner: null, lbExcluded: {}, serverFingerprint: null, serverSentAt: null, serverTriedAt: null,
  };
}
