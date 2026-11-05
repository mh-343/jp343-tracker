import type { Platform } from '../types';
import { getLocalDateString, shiftDateString } from './format-utils';

export type SpeedMedium = 'text' | 'manga';
export type SpeedStatus = 'ok' | 'learning' | 'stale';

export interface SpeedLane {
  lane: string;
  medium: SpeedMedium;
  platform: string;
  status: SpeedStatus;
  cph: number | null;
  p25: number | null;
  p75: number | null;
  days: number;
  secs: number;
  needDays: number;
  needSecs: number;
}

export interface SpeedLanes {
  lanes: SpeedLane[];
  primary: string | null;
}

export interface SpeedEntry {
  date: string;
  duration_min: number;
  chars?: number;
  platform: Platform;
}

// same rules as the server speed lanes
const MIN_DAY_SECS = 600;
const MAX_CPH = 60000;
const MIN_DAYS = 5;
const MIN_SECS = 7200;
const WINDOW = 20;
const HORIZON_DAYS = 180;
const PRIMARY_DAYS = 90;

// sources this browser tracks itself, server order
const LOCAL_LANES: { lane: string; medium: SpeedMedium; platform: Platform }[] = [
  { lane: 'text_ttsu', medium: 'text', platform: 'ttu' },
  { lane: 'manga_mokuro', medium: 'manga', platform: 'mokuro' }
];

function median(sorted: number[]): number {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function nearestRank(sorted: number[], p: number): number {
  const n = sorted.length;
  return sorted[Math.max(0, Math.min(n - 1, Math.ceil(p / 100 * n) - 1))];
}

function round100(v: number): number {
  return Math.round(v / 100) * 100;
}

export function speedLanesFromEntries(entries: SpeedEntry[], dayStartHour: number, today: string): SpeedLanes {
  const horizon = shiftDateString(today, -HORIZON_DAYS);
  const recent = shiftDateString(today, -PRIMARY_DAYS);
  const lanes: SpeedLane[] = [];
  let primary: string | null = null;
  let best: { secs: number; day: string } | null = null;

  for (const def of LOCAL_LANES) {
    const cells: Record<string, { chars: number; secs: number }> = {};
    for (const e of entries) {
      const secs = Math.round(e.duration_min * 60);
      const chars = Math.max(0, e.chars ?? 0);
      if (e.platform !== def.platform || secs <= 0 || chars <= 0) continue;
      const day = getLocalDateString(new Date(e.date), dayStartHour);
      const cell = cells[day] ?? (cells[day] = { chars: 0, secs: 0 });
      cell.chars += chars;
      cell.secs += secs;
    }
    const days = Object.keys(cells).sort().reverse();
    if (days.length === 0) continue;

    const rates: number[] = [];
    let winSecs = 0;
    let recentSecs = 0;
    for (const day of days) {
      if (day < horizon) continue;
      const { chars, secs } = cells[day];
      if (secs < MIN_DAY_SECS || chars * 3600 / secs > MAX_CPH) continue;
      if (day >= recent) recentSecs += secs;
      if (rates.length < WINDOW) {
        rates.push(chars * 3600 / secs);
        winSecs += secs;
      }
    }
    const ok = rates.length >= MIN_DAYS && winSecs >= MIN_SECS;
    const lastDay = days[0];
    const sorted = [...rates].sort((a, b) => a - b);
    lanes.push({
      lane: def.lane,
      medium: def.medium,
      platform: def.platform,
      status: ok ? 'ok' : lastDay < horizon ? 'stale' : 'learning',
      cph: ok ? round100(median(sorted)) : null,
      p25: ok ? round100(nearestRank(sorted, 25)) : null,
      p75: ok ? round100(nearestRank(sorted, 75)) : null,
      days: rates.length,
      secs: winSecs,
      needDays: MIN_DAYS,
      needSecs: MIN_SECS
    });
    // most recent reading time wins, ties go to the latest day
    if (ok && (!best || recentSecs > best.secs || (recentSecs === best.secs && lastDay > best.day))) {
      best = { secs: recentSecs, day: lastDay };
      primary = def.lane;
    }
  }
  return { lanes, primary };
}
