// own deinflection rules (port of deinflect.mjs)

const IROW_TO_UROW: Record<string, string> = { き: 'く', ぎ: 'ぐ', し: 'す', じ: 'ず', ち: 'つ', に: 'ぬ', ひ: 'ふ', び: 'ぶ', み: 'む', り: 'る', い: 'う' };
const AROW_TO_UROW: Record<string, string> = { か: 'く', が: 'ぐ', さ: 'す', ざ: 'ず', た: 'つ', な: 'ぬ', ば: 'ぶ', ま: 'む', ら: 'る', わ: 'う' };

function godanFromIrow(stem: string): string | null {
  const m = IROW_TO_UROW[stem.slice(-1)];
  return m ? stem.slice(0, -1) + m : null;
}
function godanFromArow(stem: string): string | null {
  const m = AROW_TO_UROW[stem.slice(-1)];
  return m ? stem.slice(0, -1) + m : null;
}

function completeStem(stem: string, out: Set<string>): void {
  if (stem.length < 1) return;
  out.add(stem + 'る');
  const g = godanFromIrow(stem);
  if (g) out.add(g);
}

const IADJ = ['くありません', 'くなかった', 'くなくて', 'くない', 'かった', 'くて', 'ければ', 'かろう', 'く', 'さ'];

type Rule = [string, (b: string, o: Set<string>) => void];

const RULES: Rule[] = [
  ['ませんでした', (b, o) => completeStem(b, o)],
  ['ませんで', (b, o) => completeStem(b, o)],
  ['ましょう', (b, o) => completeStem(b, o)],
  ['ますまい', (b, o) => completeStem(b, o)],
  ['ません', (b, o) => completeStem(b, o)],
  ['ました', (b, o) => completeStem(b, o)],
  ['まして', (b, o) => completeStem(b, o)],
  ['ませ', (b, o) => completeStem(b, o)],
  ['ます', (b, o) => completeStem(b, o)],
  ['まし', (b, o) => completeStem(b, o)],
  ['たがる', (b, o) => completeStem(b, o)],
  ['たかった', (b, o) => completeStem(b, o)],
  ['たくない', (b, o) => completeStem(b, o)],
  ['たくて', (b, o) => completeStem(b, o)],
  ['たい', (b, o) => completeStem(b, o)],
  ['たく', (b, o) => completeStem(b, o)],
  ['ながら', (b, o) => completeStem(b, o)],
  ['そう', (b, o) => completeStem(b, o)],
  ['やすい', (b, o) => completeStem(b, o)],
  ['にくい', (b, o) => completeStem(b, o)],
  ['なかった', (b, o) => { o.add(b + 'る'); const g = godanFromArow(b); if (g) o.add(g); }],
  ['なくて', (b, o) => { o.add(b + 'る'); const g = godanFromArow(b); if (g) o.add(g); }],
  ['なければ', (b, o) => { o.add(b + 'る'); const g = godanFromArow(b); if (g) o.add(g); }],
  ['ない', (b, o) => { o.add(b + 'る'); const g = godanFromArow(b); if (g) o.add(g); }],
  ['ず', (b, o) => { o.add(b + 'る'); const g = godanFromArow(b); if (g) o.add(g); }],
  ['ぬ', (b, o) => { o.add(b + 'る'); const g = godanFromArow(b); if (g) o.add(g); }],
  ['させられ', (b, o) => { o.add(b + 'る'); const g = godanFromArow(b); if (g) o.add(g); }],
  ['られ', (b, o) => { o.add(b + 'る'); }],
  ['させ', (b, o) => { o.add(b + 'る'); const g = godanFromArow(b); if (g) o.add(g); }],
  ['れ', (b, o) => { const g = godanFromArow(b); if (g) o.add(g); o.add(b + 'る'); }],
  ['せ', (b, o) => { const g = godanFromArow(b); if (g) o.add(g); }],
  ['って', (b, o) => { o.add(b + 'う'); o.add(b + 'つ'); o.add(b + 'る'); o.add(b + 'く'); }],
  ['った', (b, o) => { o.add(b + 'う'); o.add(b + 'つ'); o.add(b + 'る'); o.add(b + 'く'); }],
  ['んで', (b, o) => { o.add(b + 'む'); o.add(b + 'ぶ'); o.add(b + 'ぬ'); }],
  ['んだ', (b, o) => { o.add(b + 'む'); o.add(b + 'ぶ'); o.add(b + 'ぬ'); }],
  ['いて', (b, o) => { o.add(b + 'く'); }],
  ['いた', (b, o) => { o.add(b + 'く'); }],
  ['いで', (b, o) => { o.add(b + 'ぐ'); }],
  ['いだ', (b, o) => { o.add(b + 'ぐ'); }],
  ['して', (b, o) => { o.add(b + 'す'); completeStem(b, o); }],
  ['した', (b, o) => { o.add(b + 'す'); completeStem(b, o); }],
  ['て', (b, o) => { o.add(b + 'る'); }],
  ['た', (b, o) => { o.add(b + 'る'); }],
  ['れば', (b, o) => { const g = godanFromIrow(b); if (g) o.add(g); }],
  ['よう', (b, o) => { o.add(b + 'る'); }],
  ['ろ', (b, o) => { o.add(b + 'る'); }],
  ['え', (b, o) => { o.add(b + 'える'); }],
];

RULES.sort((a, b) => b[0].length - a[0].length);

const MEMO = new Map<string, string[]>();

export function deinflectCandidates(word: string): string[] {
  const cached = MEMO.get(word);
  if (cached) return cached;
  const result = computeCandidates(word);
  if (MEMO.size < 200000) MEMO.set(word, result);
  return result;
}

function computeCandidates(word: string): string[] {
  const out = new Set<string>([word]);
  if (word.length < 2) return [...out];

  for (const suf of IADJ) {
    if (word.length > suf.length && word.endsWith(suf)) {
      out.add(word.slice(0, -suf.length) + 'い');
    }
  }

  // bounded BFS unwinds stacked inflections
  const seen = new Set<string>([word]);
  const queue: Array<[string, number]> = [[word, 0]];
  let expanded = 0;
  while (queue.length && expanded < 30) {
    const [w, depth] = queue.shift()!;
    if (depth >= 5) continue;
    expanded++;
    for (const [suf, fn] of RULES) {
      if (w.length > suf.length && w.endsWith(suf)) {
        const base = w.slice(0, -suf.length);
        const children = new Set<string>();
        fn(base, children);
        for (const c of children) {
          out.add(c);
          if (!seen.has(c) && c.length >= 2) {
            seen.add(c);
            queue.push([c, depth + 1]);
          }
        }
      }
    }
  }
  return [...out];
}
