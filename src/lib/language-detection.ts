const KANA_PATTERN = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HIRAGANA_PATTERN = /\p{Script=Hiragana}/u;
const KANJI_PATTERN = /\p{Script=Han}/u;
const LATIN_PATTERN = /\p{Script=Latin}/u;
const JP_SCRIPT_GLOBAL = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu;
const LATIN_GLOBAL = /\p{Script=Latin}/gu;

const DECORATIVE_CHARS = /[≧≦°ಠ●◕○◯⊙▽△∩∪ﾟ∇♪ω◇◆◎⌒※☆★♡♥︶︸ಥ¬╯╰┻┳━┛┗┓┏┫┣╋╂┃━─┌┐└┘├┤┴┬╱╲╳_]/u;

const NOISE_STRINGS = ['fypシ゚', 'fypシ', 'ミックスリスト'];

function normalize(text: string): string {
  return NOISE_STRINGS.reduce((t, noise) => t.replaceAll(noise, ''), text);
}

export function isJapaneseContent(text: string): boolean {
  const input = normalize(text);

  // hiragana is unique to Japanese
  if (DECORATIVE_CHARS.test(input)) {
    return HIRAGANA_PATTERN.test(input);
  }

  return KANA_PATTERN.test(input);
}

export function isJapaneseLanguageCode(code: string | null | undefined): boolean {
  if (!code) return false;
  const c = code.toLowerCase();
  return c === 'ja' || c.startsWith('ja-');
}

export function containsKanji(text: string): boolean {
  return KANJI_PATTERN.test(text);
}

interface JapaneseVideoSignals {
  title: string;
  originalTitle?: string | null;
  channelName?: string | null;
  audioLanguage?: string | null;
  description?: string | null;
}

// mostly Japanese, not a few terms
function isPredominantlyJapanese(text: string | null | undefined): boolean {
  if (!text) return false;
  const jp = (text.match(JP_SCRIPT_GLOBAL) || []).length;
  if (jp < 5) return false;
  const latin = (text.match(LATIN_GLOBAL) || []).length;
  return jp / (jp + latin) >= 0.3;
}

function hasJapaneseScript(text: string): boolean {
  return KANA_PATTERN.test(text) || KANJI_PATTERN.test(text);
}

// Latin letters with no Japanese script
function isClearlyNonJapaneseTitle(text: string | null | undefined): boolean {
  if (!text) return false;
  return LATIN_PATTERN.test(text) && !hasJapaneseScript(text);
}

export function isLikelyJapaneseVideo(signals: JapaneseVideoSignals): boolean {
  if (isJapaneseContent(signals.title)) return true;
  if (signals.originalTitle && isJapaneseContent(signals.originalTitle)) return true;
  if (isPredominantlyJapanese(signals.description)) return true;
  const titleHasKanji = containsKanji(signals.title)
    || (!!signals.originalTitle && containsKanji(signals.originalTitle));
  if (titleHasKanji && !!signals.channelName && isJapaneseContent(signals.channelName)) return true;
  // audio language is only a guess
  if (isJapaneseLanguageCode(signals.audioLanguage)) {
    if (!isClearlyNonJapaneseTitle(signals.title) && !isClearlyNonJapaneseTitle(signals.originalTitle)) {
      return true;
    }
  }
  return false;
}
