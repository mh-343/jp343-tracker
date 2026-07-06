// local difficulty estimator (Paket J)
import anchorsData from './data/anchors.json';
import jlptData from './data/jlpt-index.json';
import { makeClassifier, tildeHint } from './classify';
import { buildIndex } from './jlpt';
import { extractFeatures } from './features';
import { parseJson3 } from './parse';
import { isMusicTitle, transcriptGuard } from './guards';
import { applyChannelCorrective } from './channel-corrective';
import { clampLevel } from '../difficulty-seeds';
import type { DifficultySeed, ChannelBounds } from '../difficulty-seeds';
import type { AnchorBundle, Json3Transcript } from './types';

const BUNDLE = anchorsData as unknown as AnchorBundle;
const INDEX = buildIndex(jlptData as unknown as Record<string, number>);
const classify = makeClassifier(BUNDLE);

export const LOCAL_METHOD_VERSION = BUNDLE.method_version;

export interface LocalEstimateInput {
  json3: Json3Transcript;
  title: string;
  durationSec: number | null;
  channelBounds?: ChannelBounds | null;
}

export interface LocalEstimate {
  seed: DifficultySeed;
  clamped: boolean;
}

export function estimateLocalBand(input: LocalEstimateInput): LocalEstimate | null {
  if (isMusicTitle(input.title)) return null;
  const parsed = parseJson3(input.json3);
  if (!parsed) return null;
  if (transcriptGuard(parsed.activeMin, input.durationSec)) return null;

  const feats = extractFeatures(INDEX, parsed, { kanjiMora: BUNDLE.kanji_mora });
  const raw = classify(feats);
  const bounds = input.channelBounds ?? null;
  const band = applyChannelCorrective({ min: raw.min, max: raw.max, center: raw.center }, bounds);
  const hint = tildeHint(band.min, band.max);

  return { seed: { level: clampLevel(band.center), jlptHint: hint }, clamped: bounds !== null };
}
