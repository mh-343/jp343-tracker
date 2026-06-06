const KANA_PATTERN = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HIRAGANA_PATTERN = /\p{Script=Hiragana}/u;
const KATAKANA_PATTERN = /\p{Script=Katakana}/u;
const KANJI_PATTERN = /\p{Script=Han}/u;

const DECORATIVE_CHARS = /[≧≦°ಠ●◕○◯⊙▽△∩∪ﾟ∇♪ω◇◆◎⌒※☆★♡♥︶︸ಥ¬╯╰┻┳━┛┗┓┏┫┣╋╂┃━─┌┐└┘├┤┴┬╱╲╳_]/u;

const NOISE_STRINGS = ['fypシ゚', 'fypシ', 'ミックスリスト'];

function normalize(text: string): string {
  return NOISE_STRINGS.reduce((t, noise) => t.replaceAll(noise, ''), text);
}

export function isJapaneseContent(text: string): boolean {
  const input = normalize(text);

  if (DECORATIVE_CHARS.test(input)) {
    return (
      HIRAGANA_PATTERN.test(input) &&
      KATAKANA_PATTERN.test(input) &&
      KANJI_PATTERN.test(input)
    );
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
}

export function isLikelyJapaneseVideo(signals: JapaneseVideoSignals): boolean {
  if (isJapaneseLanguageCode(signals.audioLanguage)) return true;
  if (isJapaneseContent(signals.title)) return true;
  if (signals.originalTitle && isJapaneseContent(signals.originalTitle)) return true;
  const titleHasKanji = containsKanji(signals.title)
    || (!!signals.originalTitle && containsKanji(signals.originalTitle));
  if (titleHasKanji && !!signals.channelName && isJapaneseContent(signals.channelName)) return true;
  return false;
}
