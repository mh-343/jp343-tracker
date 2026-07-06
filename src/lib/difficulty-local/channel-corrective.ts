// channel corrective clamp (port of anchors.py)
import type { ChannelBounds } from '../difficulty-seeds';

interface Band {
  min: number;
  max: number;
  center: number;
}

export function applyChannelCorrective(band: Band, bounds: ChannelBounds | null): Band {
  if (!bounds) return band;
  if (bounds.native) return { min: 5, max: 5, center: 5 };
  const lo2 = Math.max(band.min, bounds.min - 1);
  const hi2 = Math.min(band.max, bounds.max + 1);
  const center2 = Math.min(Math.max(band.center, bounds.min - 1), bounds.max + 1);
  if (lo2 > hi2) return { min: center2, max: center2, center: center2 };
  return { min: lo2, max: hi2, center: center2 };
}
