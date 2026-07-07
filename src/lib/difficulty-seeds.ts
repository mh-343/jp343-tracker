export interface DifficultySeed {
  level: 1 | 2 | 3 | 4 | 5;
  jlptHint: string;
  mixed?: boolean;
}

export interface ChannelBounds {
  min: number;
  max: number;
  native: boolean;
}

export function clampLevel(value: number): 1 | 2 | 3 | 4 | 5 {
  return Math.min(5, Math.max(1, Math.round(value))) as 1 | 2 | 3 | 4 | 5;
}

const CUE = /jlpt|level|レベル|級|listening|immersion|practice|comprehensible|elementary|beginner|intermediate|advanced/;
const META = /問題を解|解いてみた|模試|過去問|開催|募集|講座|勉強法|合格|受かる|受験|受けてみた|test your|quiz|too easy|can you pass|easy or difficult to pass|how to (pass|study)|study (method|tip|plan|guide)|are you really/;

// [pattern, easy JLPT, hard JLPT]
const JWORD: Array<[RegExp, number, number]> = [
  [/初級/, 5, 4],
  [/中級/, 3, 2],
  [/上級/, 2, 1],
  [/入門/, 5, 4],
];

function collectLevels(text: string): Set<number> {
  const levels = new Set<number>();
  for (const m of text.matchAll(/(?<![a-z0-9])n\s?([1-5])(?![0-9.])/g)) {
    levels.add(Number(m[1]));
  }
  for (const m of text.matchAll(/(?<![a-z0-9])n\s?[1-5]\s*[-–—〜~/]\s*([1-5])(?![0-9.])/g)) {
    levels.add(Number(m[1]));
  }
  for (const m of text.matchAll(/jlpt\s*n?\s*([1-5])(?![0-9])(?:\s*[-–—〜~/]\s*n?\s*([1-5])(?![0-9]))?/g)) {
    levels.add(Number(m[1]));
    if (m[2]) levels.add(Number(m[2]));
  }
  return levels;
}

function buildSeed(levels: Set<number>): DifficultySeed {
  const nums = [...levels];
  const easiest = Math.max(...nums);
  const hardest = Math.min(...nums);
  const jlptHint = easiest === hardest ? `~N${hardest}` : `~N${easiest}-N${hardest}`;
  const centre = (6 - easiest + (6 - hardest)) / 2;
  return { level: clampLevel(centre), jlptHint };
}

function japaneseWordSeed(text: string): DifficultySeed | null {
  for (const [re, easy, hard] of JWORD) {
    if (re.test(text)) return buildSeed(new Set([easy, hard]));
  }
  return null;
}

export function parseTitleLevel(title: string): DifficultySeed | null {
  const text = title.normalize('NFKC').toLowerCase();
  const brackets = text.match(/【[^】]*】|\([^)]*\)|\[[^\]]*\]/g);
  if (brackets) {
    // explicit tags skip meta filter
    const bracketLevels = collectLevels(brackets.join(' '));
    if (bracketLevels.size) return buildSeed(bracketLevels);
  }
  if (META.test(text)) return null;
  const freeLevels = collectLevels(text);
  if (freeLevels.size >= 2 || (freeLevels.size === 1 && CUE.test(text))) {
    return buildSeed(freeLevels);
  }
  return japaneseWordSeed(text);
}
