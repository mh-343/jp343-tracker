import type { PendingEntry } from '../../types';
import { getLocalDateString } from '../../lib/format-utils';
import { attentionMinutes } from '../../lib/attention';
import type { ServerSession } from './api';

export interface AttentionAggregate {
  activeMin: number;
  passiveMin: number;
  totalMin: number;
  tagged: boolean;
}

export interface ServerSessionGroup {
  first: ServerSession;
  members: ServerSession[];
  agg: AttentionAggregate;
}

export interface PendingGroup {
  first: PendingEntry;
  members: PendingEntry[];
  agg: AttentionAggregate;
}

export function serverSessionShare(s: ServerSession): number | null {
  if (s.passiveShare !== undefined) return s.passiveShare;
  if (s.isPassive === undefined) return null;
  return s.isPassive ? 1 : 0;
}

function historyGroupKey(projectKey: string, dateStr: string | undefined, tagged: boolean, dayStartHour: number): string {
  const day = dateStr ? getLocalDateString(new Date(dateStr), dayStartHour) : '';
  return `${projectKey}|${day}|${tagged ? 't' : 'u'}`;
}

export function groupServerSessions(sessions: ServerSession[], dayStartHour: number): ServerSessionGroup[] {
  const byKey = new Map<string, ServerSessionGroup>();
  const groups: ServerSessionGroup[] = [];
  for (const s of sessions) {
    const share = serverSessionShare(s);
    const tagged = share !== null;
    const key = historyGroupKey(s.project_id || s.title || '', s.date, tagged, dayStartHour);
    let group = byKey.get(key);
    if (!group) {
      group = { first: s, members: [], agg: { activeMin: 0, passiveMin: 0, totalMin: 0, tagged } };
      byKey.set(key, group);
      groups.push(group);
    }
    group.members.push(s);
    const min = (s.duration_seconds || 0) / 60;
    group.agg.totalMin += min;
    if (share !== null) {
      group.agg.passiveMin += min * share;
      group.agg.activeMin += min * (1 - share);
    }
  }
  return groups;
}

export function groupPendingEntries(entries: PendingEntry[], dayStartHour: number, visibleActive: boolean): PendingGroup[] {
  const byKey = new Map<string, PendingGroup>();
  const groups: PendingGroup[] = [];
  for (const entry of entries) {
    const split = attentionMinutes(entry, visibleActive);
    const tagged = split !== null;
    const key = historyGroupKey(`${entry.project_id}|${entry.project}`, entry.date, tagged, dayStartHour);
    let group = byKey.get(key);
    if (!group) {
      group = { first: entry, members: [], agg: { activeMin: 0, passiveMin: 0, totalMin: 0, tagged } };
      byKey.set(key, group);
      groups.push(group);
    }
    group.members.push(entry);
    group.agg.totalMin += entry.duration_min;
    if (split) {
      group.agg.activeMin += split.activeMin;
      group.agg.passiveMin += split.passiveMin;
    }
  }
  return groups;
}
