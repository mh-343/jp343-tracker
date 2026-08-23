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

export type LocalEstimateOutcome =
  | { state: 'ok'; seed: DifficultySeed; clamped: boolean; speechRatio: number | null }
  | { state: 'music_title' }
  | { state: 'low_speech'; speechRatio: number }
  | { state: 'no_transcript' };

export function estimateLocalBand(input: LocalEstimateInput): LocalEstimateOutcome {
  if (isMusicTitle(input.title)) return { state: 'music_title' };
  const parsed = parseJson3(input.json3);
  if (!parsed) return { state: 'no_transcript' };
  const speechRatio = input.durationSec ? parsed.activeMin / (input.durationSec / 60) : null;
  if (speechRatio !== null && transcriptGuard(parsed.activeMin, input.durationSec)) {
    return { state: 'low_speech', speechRatio };
  }

  const feats = extractFeatures(INDEX, parsed, { kanjiMora: BUNDLE.kanji_mora });
  const raw = classify(feats);
  const bounds = input.channelBounds ?? null;
  const band = applyChannelCorrective({ min: raw.min, max: raw.max, center: raw.center }, bounds);
  const hint = tildeHint(band.min, band.max);

  return {
    state: 'ok',
    seed: { level: clampLevel(band.center), jlptHint: hint },
    clamped: bounds !== null,
    speechRatio
  };
}
