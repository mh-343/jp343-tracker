// kNN band numerics (port of knn.mjs), numpy-faithful

export const K = 7;

type FeatMap = Record<string, number>;

export interface MatrixRow {
  level: number;
  feats: FeatMap;
}

export interface Matrix {
  Xz: number[][];
  y: number[];
  mu: number[];
  sd: number[];
  lo: number[];
  hi: number[];
  features: string[];
}

function mean(a: number[]): number {
  let s = 0;
  for (const x of a) s += x;
  return s / a.length;
}
function popStd(a: number[], mu: number): number {
  let s = 0;
  for (const x of a) s += (x - mu) * (x - mu);
  return Math.sqrt(s / a.length);
}
// round half to even
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}
// numpy.percentile, linear interpolation
function percentile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const idx = (q / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] + frac * (sorted[hi] - sorted[lo]);
}
function median(sorted: number[]): number {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function buildMatrix(rows: MatrixRow[], features: string[]): Matrix {
  const d = features.length;
  const X = rows.map((r) => features.map((k) => r.feats[k]));
  const mu: number[] = [];
  const sd: number[] = [];
  const lo: number[] = [];
  const hi: number[] = [];
  for (let c = 0; c < d; c++) {
    const col = X.map((row) => row[c]);
    const m = mean(col);
    mu.push(m);
    sd.push(popStd(col, m) + 1e-9);
    lo.push(Math.min(...col));
    hi.push(Math.max(...col));
  }
  const Xz = X.map((row) => row.map((v, c) => (v - mu[c]) / sd[c]));
  const y = rows.map((r) => r.level);
  return { Xz, y, mu, sd, lo, hi, features };
}

export function zvec(feats: FeatMap, m: Matrix): number[] {
  return m.features.map((k, c) => {
    let v = feats[k];
    if (v < m.lo[c]) v = m.lo[c];
    else if (v > m.hi[c]) v = m.hi[c];
    return (v - m.mu[c]) / m.sd[c];
  });
}

export function knnLabels(m: Matrix, vec: number[]): number[] {
  const d = m.Xz.map((row) => {
    let s = 0;
    for (let c = 0; c < vec.length; c++) {
      const diff = row[c] - vec[c];
      s += diff * diff;
    }
    return Math.sqrt(s);
  });
  const order = d.map((dist, i) => [dist, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const labels = order.slice(0, K).map(([, i]) => m.y[i]);
  labels.sort((a, b) => a - b);
  return labels;
}

export function bandOf(lbl: number[]): { lo: number; hi: number; center: number } {
  const s = [...lbl].sort((a, b) => a - b);
  const lo = roundHalfEven(percentile(s, 25));
  const hi = roundHalfEven(percentile(s, 75));
  const center = roundHalfEven(median(s));
  return { lo, hi, center };
}
