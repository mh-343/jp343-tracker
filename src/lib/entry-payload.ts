import type { PendingEntry } from '../types';
import { buildSensorParams } from './background/sensor-params';

export function buildEntryParams(entry: PendingEntry, completedPids: Set<string> = new Set()): Record<string, string> {
  const completed = completedPids.has(entry.project_id) ? true : entry.readingCompleted;
  return {
    project_id: entry.project_id,
    duration_seconds: String(Math.round(entry.duration_min * 60)),
    chars: String(Math.round(entry.chars ?? 0)),
    source: 'extension',
    session_id: entry.id,
    type: entry.activityType ?? 'watching',
    notes: '',
    project_title: entry.project,
    project_url: entry.url,
    project_thumbnail: entry.thumbnail || '',
    channel_id: entry.channelId || '',
    channel_name: entry.channelName || '',
    channel_url: entry.channelUrl || '',
    video_title: entry.project,
    resource_url: entry.url,
    thumbnail: entry.thumbnail || '',
    platform: entry.platform,
    date: entry.date.replace('T', ' ').replace(/\.\d+Z$/, '').slice(0, 19),
    ...(entry.mergeResync ? { merge_resync: '1' } : {}),
    ...(entry.readingCurrentPage != null ? { reading_current_page: String(entry.readingCurrentPage) } : {}),
    ...(completed != null ? { reading_completed: completed ? '1' : '0' } : {}),
    ...(entry.langSignal === 'ja'
      ? {
          lang_signal: 'ja',
          ...(entry.langSignalSrc === 'script' || entry.langSignalSrc === 'declared'
            ? { lang_signal_src: entry.langSignalSrc }
            : {})
        }
      : {}),
    ...(typeof entry.isPassive === 'boolean' ? { is_passive: entry.isPassive ? '1' : '0' } : {}),
    ...buildSensorParams(entry)
  };
}

export function entryPayloadKey(entry: PendingEntry): string {
  const params = buildEntryParams(entry);
  delete params.merge_resync;
  return JSON.stringify(params);
}
