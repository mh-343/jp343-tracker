// feature extractor (port of features.mjs)
import { deinflectCandidates } from './deinflect';
import { lookupLevel } from './jlpt';
import type { JlptIndex } from './jlpt';
import {
  isKana, isKanji, isSmallKana, isJapaneseChar,
  hasKanji, allKanji, allKatakana, allHiragana,
} from './jscript';
import type { ParsedTranscript } from './types';

interface SegmentData { segment: string; isWordLike?: boolean }
interface JsSegmenter { segment(input: string): Iterable<SegmentData> }
interface SegmenterCtor { new (locale: string, options: { granularity: string }): JsSegmenter }

const SEGMENTER: JsSegmenter =
  new (Intl as unknown as { Segmenter: SegmenterCtor }).Segmenter('ja', { granularity: 'word' });

const UROW = new Set(['く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む', 'る', 'う']);

type SegClass = 'SPACE' | 'PARTICLE' | 'AUX' | 'PUNCT' | 'CONTENT';

interface Seg {
  surface: string;
  cls: SegClass;
  isVerbHead: boolean;
}

const PARTICLES = new Set([
  'は', 'が', 'を', 'に', 'へ', 'と', 'で', 'も', 'の', 'や', 'か', 'ね', 'よ', 'わ',
  'ぞ', 'ぜ', 'さ', 'な', 'ら', 'ば', 'し', 'ので', 'のに', 'から', 'まで', 'より',
  'だけ', 'ほど', 'くらい', 'ぐらい', 'など', 'なんか', 'なんて', 'ばかり', 'きり',
  'しか', 'こそ', 'でも', 'とか', 'って', 'ては', 'では', 'には', 'にも', 'とも',
  'へは', 'をも', 'じゃ', 'かな', 'かしら', 'っけ', 'のみ', 'すら', 'さえ', 'ずつ',
  'ながらも', 'ものの', 'けれど', 'けれども', 'つまり',
  'けど', 'かも', 'よね', 'じゃあ', 'なので', 'だって', 'という', 'っていう', 'ていう',
  'とは', 'でしょ', 'でしょう', 'だろう', 'だろ', 'みたいな', 'みたい', 'ってか',
]);

const AUX_TAIL = new Set([
  'られ', 'れ', 'せ', 'させ', 'れる', 'られる', 'せる', 'させる',
  'なかっ', 'なく', 'ない', 'なけれ', 'なきゃ', 'ず', 'ぬ',
  'ます', 'まし', 'ませ', 'ました', 'ません', 'ませんでした', 'ましょう', 'ましょ',
  'です', 'でし', 'でした', 'だ', 'だっ', 'た', 'て', 'で',
  'たい', 'たく', 'たかっ', 'たがっ', 'そう', 'よう', 'らしい',
  'ちゃっ', 'じゃっ', 'ちゃ', 'じゃ', 'てる', 'てい', 'でる', 'でい',
  'とい', 'とっ', 'ば', 'う', 'ちゃう', 'じゃう', 'しまう', 'ちゃった',
]);
const VERB_TAIL = new Set([
  'られ', 'れ', 'せ', 'させ', 'れる', 'られる', 'せる', 'させる',
  'なかっ', 'なく', 'ない', 'なけれ', 'ず', 'ぬ', 'ます', 'まし', 'ませ',
  'ました', 'ません', 'た', 'て', 'たい', 'たく', 'よう', 'てる', 'てい',
]);

function isPunctSeg(s: string): boolean {
  for (const c of s) if (isJapaneseChar(c) || /[A-Za-z0-9]/.test(c)) return false;
  return true;
}

function classifySeg(surface: string, wordLike: boolean): SegClass {
  if (!surface.trim()) return 'SPACE';
  if (PARTICLES.has(surface)) return 'PARTICLE';
  if (AUX_TAIL.has(surface)) return 'AUX';
  if (!wordLike || isPunctSeg(surface)) return 'PUNCT';
  return 'CONTENT';
}

function moraCount(text: string, kanjiMora: number): number {
  let m = 0;
  for (const c of text) {
    if (isSmallKana(c)) continue;
    else if (isKana(c)) m += 1;
    else if (isKanji(c)) m += kanjiMora;
  }
  return m;
}

function readabilityApprox(segs: Seg[]): number {
  const text = segs.map((s) => s.surface).join('');
  const nSent = Math.max(1, (text.match(/[。？！．]/g) || []).length || (text.trim() ? 1 : 1));
  let total = 0, kango = 0, wago = 0, verbs = 0, particles = 0;
  for (const s of segs) {
    if (s.cls === 'SPACE') continue;
    total += 1;
    if (s.cls === 'PUNCT') continue;
    if (s.cls === 'PARTICLE') { particles += 1; wago += 1; continue; }
    if (s.isVerbHead) verbs += 1;
    if (allKanji(s.surface) && !s.isVerbHead) kango += 1;
    else if (allKatakana(s.surface)) { /* 外来語 */ }
    else wago += 1;
  }
  if (total === 0) return 0;
  const meanLen = total / nSent;
  const kangoP = (100 * kango) / total;
  const wagoP = (100 * wago) / total;
  const verbP = (100 * verbs) / total;
  const partP = (100 * particles) / total;
  return (
    meanLen * -0.056 +
    kangoP * -0.126 +
    wagoP * -0.042 +
    verbP * -0.145 +
    partP * -0.044 +
    11.724
  );
}

export function extractFeatures(
  idx: JlptIndex,
  parsed: ParsedTranscript,
  opts: { kanjiMora?: number } = {}
): Record<string, number> {
  const kanjiMora = opts.kanjiMora ?? 1.4;
  const text = parsed.text;

  const noSpace = text.replace(/\s+/g, '');
  let jpChars = 0;
  for (const c of noSpace) if (isJapaneseChar(c)) jpChars += 1;

  const segs: Seg[] = [];
  for (const seg of SEGMENTER.segment(text)) {
    segs.push({ surface: seg.segment, cls: classifySeg(seg.segment, seg.isWordLike ?? false), isVerbHead: false });
  }

  // merge content stem + trailing kana, then bucket by JLPT
  const buckets: Record<number, number> = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0, 0: 0 };
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].cls !== 'CONTENT') continue;
    const head = segs[i];
    let merged = head.surface;
    let sawVerbTail = false;
    let j = i + 1;
    while (j < segs.length) {
      const s = segs[j];
      const cont = s.cls === 'AUX' ||
        (s.cls !== 'SPACE' && s.cls !== 'PUNCT' && s.cls !== 'PARTICLE' &&
          allHiragana(s.surface) && s.surface.length <= 3);
      if (!cont) break;
      merged += s.surface;
      if (VERB_TAIL.has(s.surface) || /^っ/.test(s.surface)) sawVerbTail = true;
      j += 1;
    }
    const isSingleHira = [...merged].length === 1 && allHiragana(merged);
    const cands = deinflectCandidates(merged);
    cands.push(head.surface);
    const lvl = lookupLevel(idx, cands);
    if (isSingleHira && lvl === 0) { i = j - 1; continue; }
    buckets[lvl] += 1;
    head.isVerbHead = sawVerbTail ||
      (merged.length >= 2 && UROW.has(merged.slice(-1)) && (hasKanji(merged) || !allKatakana(merged)));
    i = j - 1;
  }

  const n = Math.max(1, buckets[5] + buckets[4] + buckets[3] + buckets[2] + buckets[1] + buckets[0]);
  const cumEasy = (buckets[5] + buckets[4]) / n;
  const mora = moraCount(text, kanjiMora);
  const moraRate = mora / Math.max(0.1, parsed.activeMin);

  return {
    jp_ratio: jpChars / Math.max(1, noSpace.length),
    n_content: n,
    adv_ratio: (buckets[1] + buckets[2]) / n,
    mid_ratio: buckets[3] / n,
    easy_cov: cumEasy,
    unknown_ratio: buckets[0] / n,
    mora_per_min: moraRate,
    mora_raw: mora,
    readability: readabilityApprox(segs),
  };
}
