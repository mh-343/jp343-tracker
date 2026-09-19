import type { PendingEntry } from '../../types';
import type { MpchcSession, MpchcSnapshot } from '../mpchc';
import { generateProjectId } from '../time-tracker';

export const MPCHC_PERIOD_MINUTES = 0.5;
export const MPCHC_IDLE_MS = 4 * 60_000;

export async function mpchcEntry(session: MpchcSession): Promise<PendingEntry | null> {
  if (session.accumulatedMs < 60_000) return null;
  const stem = session.file.replace(/\.[^.]+$/, '');
  let projectId = generateProjectId('mpchc', session.file, null);
  if (/[^\x00-\x7f]/.test(stem) || !/[a-z0-9]/i.test(stem)) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(session.file));
    const hash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
    projectId = generateProjectId('mpchc', session.file, hash.slice(0, 32));
  }
  return {
    id: session.id, date: new Date(session.startedAt).toISOString(),
    duration_min: session.accumulatedMs / 60_000,
    project: session.file, project_id: projectId, platform: 'mpchc',
    source: 'extension', activityType: 'watching', url: '', thumbnail: null,
    channelId: null, channelName: null, channelUrl: null,
    synced: false, syncedAt: null, syncAttempts: 0, lastSyncError: null, serverEntryId: null,
  };
}

export function startMpchcSession(snapshot: MpchcSnapshot, now: number): MpchcSession {
  return {
    id: `ext_${crypto.randomUUID()}`, file: snapshot.file, startedAt: now,
    accumulatedMs: 0, lastPollAt: now, lastPosition: snapshot.position,
    lastPlaying: true, idleSince: null,
  };
}

export function advanceMpchcSession(session: MpchcSession, snapshot: MpchcSnapshot | null, now: number, periodMinutes: number): boolean {
  const playing = snapshot?.state === 2 && !!snapshot.file;
  if (playing && session.lastPlaying && snapshot.position !== session.lastPosition) {
    session.accumulatedMs += Math.max(0, Math.min(now - session.lastPollAt, periodMinutes * 120_000));
  }
  session.lastPlaying = playing;
  session.lastPollAt = now;
  if (snapshot) session.lastPosition = snapshot.position;
  if (playing || snapshot?.state === 1) session.idleSince = null;
  else session.idleSince ??= now;
  return session.idleSince !== null && now - session.idleSince >= MPCHC_IDLE_MS;
}
