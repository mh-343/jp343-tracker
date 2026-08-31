import type { AttentionMode } from '../types';

export function sampleAttention(): AttentionMode {
  return document.visibilityState === 'visible' && document.hasFocus() ? 'active' : 'passive';
}

export function normalizeIsPassive(raw: unknown): boolean | undefined {
  if (raw === 1 || raw === '1' || raw === true) return true;
  if (raw === 0 || raw === '0' || raw === false) return false;
  return undefined;
}

export const ATTENTION_SHARE_MIN_TAGGED = 0.2;

// Same contract as website weekly ratio
export function computeAttentionShare(activeMin: number, passiveMin: number, totalMin: number): number | null {
  if (totalMin <= 0) return null;
  const tagged = Math.min(activeMin + passiveMin, totalMin);
  if (tagged < ATTENTION_SHARE_MIN_TAGGED * totalMin) return null;
  return Math.round((activeMin / (activeMin + passiveMin)) * 100);
}
