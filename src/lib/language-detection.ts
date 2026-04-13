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
