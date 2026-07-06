// classifier over the frozen bundle (port)
import { buildMatrix, zvec, knnLabels, bandOf } from './knn';
import type { Matrix } from './knn';
import type { AnchorBundle, LocalBand } from './types';

function featObj(features: string[], vec: number[]): Record<string, number> {
  const o: Record<string, number> = {};
  features.forEach((k, i) => { o[k] = vec[i]; });
  return o;
}

// inverse scale: N = 6 - level
function levelToN(level: number): number {
  return 6 - level;
}

export function tildeHint(minLevel: number, maxLevel: number): string {
  const a = levelToN(minLevel);
  const b = levelToN(maxLevel);
  return a === b ? `~N${a}` : `~N${a}-N${b}`;
}

export function makeClassifier(bundle: AnchorBundle): (queryFeats: Record<string, number>) => LocalBand {
  const rows = bundle.anchors.map((a) => ({ level: a.lvl, feats: featObj(bundle.features, a.v) }));
  const m: Matrix = buildMatrix(rows, bundle.features);
  return function classify(queryFeats: Record<string, number>): LocalBand {
    const vec = zvec(queryFeats, m);
    const { lo, hi, center } = bandOf(knnLabels(m, vec));
    return { min: lo, max: hi, center, width: hi - lo, hint: tildeHint(lo, hi), src: 'local' };
  };
}
