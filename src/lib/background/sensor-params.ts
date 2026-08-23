// sensor field emission (absent = omit)
import { SENSOR_VERSION } from '../../types';
import type { PendingEntry } from '../../types';

export function buildSensorParams(entry: PendingEntry): Record<string, string> {
  const params: Record<string, string> = {};
  if (entry.platform === 'youtube') {
    if (entry.asrState) params.asr_state = entry.asrState;
    if (entry.ytCategory) params.yt_category = entry.ytCategory;
    if (entry.isLive != null) params.is_live = entry.isLive ? '1' : '0';
    // live: suppress duration and estimate
    if (entry.isLive !== true) {
      if (
        typeof entry.videoDurationSec === 'number' &&
        Number.isFinite(entry.videoDurationSec) &&
        entry.videoDurationSec > 0
      ) {
        params.video_duration_sec = String(Math.round(entry.videoDurationSec));
      }
      if (entry.estimateState) {
        params.estimate_state = entry.estimateState;
        if (
          entry.speechRatio != null &&
          (entry.estimateState === 'ok' || entry.estimateState === 'low_speech')
        ) {
          params.speech_ratio = Math.min(1, Math.max(0, entry.speechRatio)).toFixed(2);
        }
      }
    }
  }
  if (entry.trackingMode) params.tracking_mode = entry.trackingMode;
  if (Object.keys(params).length > 0) {
    params.sensor_version = String(entry.sensorVersion ?? SENSOR_VERSION);
  }
  return params;
}
