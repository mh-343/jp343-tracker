// script/char helpers (port of jscript.mjs)

const SMALL_KANA = new Set('ァィゥェォャュョヮぁぃぅぇぉゃゅょゎ');

export function isHiragana(c: string): boolean {
  const o = c.codePointAt(0) ?? 0;
  return o >= 0x3040 && o <= 0x309f;
}

export function isKatakana(c: string): boolean {
  const o = c.codePointAt(0) ?? 0;
  return o >= 0x30a0 && o <= 0x30ff;
}

export function isKana(c: string): boolean {
  return isHiragana(c) || isKatakana(c);
}

export function isKanji(c: string): boolean {
  const o = c.codePointAt(0) ?? 0;
  return (o >= 0x4e00 && o <= 0x9fff) || c === '々';
}

export function isJapaneseChar(c: string): boolean {
  const o = c.codePointAt(0) ?? 0;
  return (o >= 0x3040 && o <= 0x30ff) || (o >= 0x4e00 && o <= 0x9fff) || c === '々';
}

export function isSmallKana(c: string): boolean {
  return SMALL_KANA.has(c);
}

// shift full katakana down by 0x60
export function kataToHira(s: string): string {
  let out = '';
  for (const c of s) {
    const o = c.codePointAt(0) ?? 0;
    out += o >= 0x30a1 && o <= 0x30f6 ? String.fromCodePoint(o - 0x60) : c;
  }
  return out;
}

export function hasKanji(s: string): boolean {
  for (const c of s) if (isKanji(c)) return true;
  return false;
}

export function allHiragana(s: string): boolean {
  if (!s) return false;
  for (const c of s) if (!isHiragana(c)) return false;
  return true;
}

export function allKatakana(s: string): boolean {
  if (!s) return false;
  for (const c of s) if (!isKatakana(c)) return false;
  return true;
}

export function allKanji(s: string): boolean {
  if (!s) return false;
  for (const c of s) if (!isKanji(c)) return false;
  return true;
}
