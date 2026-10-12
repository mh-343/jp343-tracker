export const GSM_LANG_RULE = 'kana-v1';

// a changed set needs a new rule name
export const KANA_V1_PATTERNS = {
  kana: '[\u3041-\u3096\u30A1-\u30FA\uFF66-\uFF9D]',
  kanji: '[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]',
  hangul: '[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]',
  latin: '[A-Za-z]',
} as const;

const KANA = new RegExp(KANA_V1_PATTERNS.kana, 'u');
const OTHER_SCRIPT = new RegExp([KANA_V1_PATTERNS.kanji, KANA_V1_PATTERNS.hangul, KANA_V1_PATTERNS.latin].join('|'), 'u');

export interface GsmLineScript {
  script: boolean;
  kana: boolean;
}

export function classifyGsmLine(text: string): GsmLineScript {
  const kana = KANA.test(text);
  return { script: kana || OTHER_SCRIPT.test(text), kana };
}

// same threshold as the server credit rule
export function isJapaneseGsmSession(linesScript: number, linesKana: number): boolean {
  return linesScript > 0 && linesKana * 100 >= linesScript * 50;
}

const READING_CHAR = /[\p{L}\p{N}]/gu;

// rule of the JP343 Reader, not sentence_length
export function countGsmChars(text: string): number {
  return text.match(READING_CHAR)?.length ?? 0;
}

// 53-bit text key, so a repeated line counts once
export function gsmTextHash(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
