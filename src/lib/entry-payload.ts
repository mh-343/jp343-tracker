import type { PendingEntry } from '../types';
import { buildSensorParams } from './background/sensor-params';

// 255 column, headroom for "&lt;"
const MAX_CHANNEL_NAME_CHARS = 200;
const MAX_SERIES_TEXT_CHARS = 200;
const MAX_READING_CHARS = 20_000_000;
const SERIES_UUID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TTU_NEW_PID = /^ext_ttu_[0-9a-f]{16,64}$/;
const TTU_LEGACY_PID = /^ext_ttu_[0-9a-f]{8}$/;

function capChars(text: string, max: number): string {
  return text.length <= max ? text : Array.from(text).slice(0, max).join('');
}

export function wireChannelName(name: string | null | undefined): string {
  return name ? capChars(name, MAX_CHANNEL_NAME_CHARS) : '';
}

function seriesParams(entry: PendingEntry): Record<string, string> {
  const params: Record<string, string> = {};
  if (entry.seriesUuid && SERIES_UUID_PATTERN.test(entry.seriesUuid)) params.series_uuid = entry.seriesUuid;
  const series = entry.seriesTitle?.trim();
  if (series) params.series_title = capChars(series, MAX_SERIES_TEXT_CHARS);
  const volume = entry.volumeTitle?.trim();
  if (volume) params.volume_title = capChars(volume, MAX_SERIES_TEXT_CHARS);
  return params;
}

export function isValidCharPosition(offset: unknown, total: unknown): boolean {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(total)
    && Number(total) >= 1 && Number(total) <= MAX_READING_CHARS && Number(offset) >= 0 && Number(offset) <= Number(total);
}

function charPositionParams(entry: PendingEntry): Record<string, string> {
  if (entry.readingUnit !== 'char' || !isValidCharPosition(entry.readingOffset, entry.readingTotal)) return {};
  return { reading_unit: 'char', reading_offset: String(entry.readingOffset), reading_total: String(entry.readingTotal) };
}

// old ttsu tile goes over to the new id
function takeoverParams(entry: PendingEntry, takeovers: Map<string, string>): Record<string, string> {
  const legacy = takeovers.get(entry.project_id);
  return legacy && TTU_NEW_PID.test(entry.project_id) && TTU_LEGACY_PID.test(legacy) ? { legacy_project_id: legacy } : {};
}

export function buildEntryParams(
  entry: PendingEntry,
  completedPids: Set<string> = new Set(),
  takeovers: Map<string, string> = new Map()
): Record<string, string> {
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
    channel_name: wireChannelName(entry.channelName),
    channel_url: entry.channelUrl || '',
    video_title: entry.project,
    resource_url: entry.url,
    thumbnail: entry.thumbnail || '',
    platform: entry.platform,
    date: entry.date.replace('T', ' ').replace(/\.\d+Z$/, '').slice(0, 19),
    ...(entry.mergeResync ? { merge_resync: '1' } : {}),
    ...(entry.readingCurrentPage != null && entry.platform !== 'ttu' ? { reading_current_page: String(entry.readingCurrentPage) } : {}),
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
    ...(entry.platform === 'mokuro' ? seriesParams(entry) : {}),
    ...(entry.platform === 'ttu' ? { ...charPositionParams(entry), ...takeoverParams(entry, takeovers) } : {}),
    ...buildSensorParams(entry)
  };
}

export function entryPayloadKey(entry: PendingEntry): string {
  const params = buildEntryParams(entry);
  delete params.merge_resync;
  return JSON.stringify(params);
}
