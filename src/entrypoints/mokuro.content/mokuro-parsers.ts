import type { MokuroVolumeSnapshot } from '../../types';

interface RawVolume {
  timeReadInMinutes?: number;
  recentPageTurns?: [number, number, number][];
  chars?: number;
  progress?: number;
  series_title?: string;
  volume_title?: string;
  series_uuid?: string;
  completed?: boolean;
  deletedOn?: string;
}

const IDLE_CAP_MIN = 10;

function timeFromPageTurns(turns: [number, number, number][], idleMs: number): number {
  if (!turns || turns.length < 2) return 0;
  let totalMs = 0;
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1];
    const curr = turns[i];
    if (prev.length < 3 || curr.length < 3) continue;
    const gap = curr[0] - prev[0];
    if (gap > idleMs) continue;
    totalMs += gap;
  }
  return Math.floor(totalMs / 60000);
}

export function effectiveMinutes(vol: RawVolume, userIdleMin: number): number {
  const idleMs = Math.min(userIdleMin || 5, IDLE_CAP_MIN) * 60000;
  const fromTurns = timeFromPageTurns(vol.recentPageTurns || [], idleMs);
  return Math.max(fromTurns, Number(vol.timeReadInMinutes) || 0);
}

function readIdleMin(profilesRaw: string | null, currentProfile: string | null): number {
  try {
    if (!profilesRaw) return 5;
    const profiles = JSON.parse(profilesRaw) as Record<string, { inactivityTimeoutMinutes?: number }>;
    const name = currentProfile && profiles[currentProfile]
      ? currentProfile
      : (profiles.Desktop ? 'Desktop' : (profiles.Mobile ? 'Mobile' : Object.keys(profiles)[0]));
    const p = name ? profiles[name] : undefined;
    if (p && typeof p.inactivityTimeoutMinutes === 'number') return p.inactivityTimeoutMinutes;
  } catch {
    return 5;
  }
  return 5;
}

export function buildSnapshot(
  volumesRaw: string | null,
  profilesRaw: string | null,
  currentProfile: string | null
): Record<string, MokuroVolumeSnapshot> {
  let volumes: Record<string, RawVolume> = {};
  try {
    volumes = volumesRaw ? (JSON.parse(volumesRaw) as Record<string, RawVolume>) : {};
  } catch {
    volumes = {};
  }

  const userIdleMin = readIdleMin(profilesRaw, currentProfile);
  const out: Record<string, MokuroVolumeSnapshot> = {};
  for (const id of Object.keys(volumes)) {
    if (!id) continue;
    const v = volumes[id];
    out[id] = {
      effectiveMin: effectiveMinutes(v, userIdleMin),
      chars: Number(v.chars) || 0,
      currentPage: Number(v.progress) || 0,
      seriesTitle: v.series_title ?? null,
      volumeTitle: v.volume_title ?? null,
      seriesUuid: v.series_uuid ?? null,
      completed: !!v.completed,
      deleted: !!v.deletedOn
    };
  }
  return out;
}
