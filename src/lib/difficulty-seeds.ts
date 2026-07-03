export interface DifficultySeed {
  level: 1 | 2 | 3 | 4 | 5;
  jlptHint: string;
  mixed?: boolean;
}

const LEVEL_HINTS: Record<number, string> = {
  1: '~N5',
  2: '~N4',
  3: '~N3',
  4: '~N2',
  5: '~N1',
};

function seed(level: 1 | 2 | 3 | 4 | 5, mixed?: boolean): DifficultySeed {
  return { level, jlptHint: LEVEL_HINTS[level], mixed };
}

// Prototype hand seeds
const SEEDS: Record<string, DifficultySeed> = {
  '@cijapanese': seed(1),
  'comprehensible japanese': seed(1),
  '@kanamenaito': seed(1),
  'kaname naito': seed(1),
  '@japanesewithshun': seed(1),
  'japanese with shun': seed(1),
  '@nihongonojikan': seed(1),
  'にほんごのじかん': seed(1),
  '@dogen': seed(2),
  'dogen': seed(2),
  '@gamegengo': seed(2),
  'game gengo ゲーム言語': seed(2),
  '@yuyunihongopodcast': seed(2),
  'yuyuの日本語podcast': seed(2),
  'speak japanese naturally': seed(2),
  'the bitesize japanese podcast': seed(3),
  'bite size japanese': seed(3),
  'キヨ。': seed(3),
  'はじめしゃちょー（hajime）': seed(3),
  '@hajimesyacho': seed(3),
  'レトルト': seed(3),
  '牛沢': seed(3),
  'hikakintv': seed(3),
  "fischer's-フィッシャーズ-": seed(4, true),
  'annnewsch': seed(5),
  '@annnewsch': seed(5),
  '日テレnews': seed(5),
};

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

export function lookupDifficultySeed(
  channelId: string | null,
  channelName: string | null
): DifficultySeed | null {
  if (channelId) {
    const byId = SEEDS[normalizeKey(channelId)];
    if (byId) return byId;
  }
  if (channelName) {
    const byName = SEEDS[normalizeKey(channelName)];
    if (byName) return byName;
  }
  return null;
}

export function parseTitleLevel(title: string): DifficultySeed | null {
  const blocks = title.match(/【[^】]*】/g);
  if (!blocks) return null;
  for (const block of blocks) {
    const tags = block.match(/N[1-5]/g);
    if (!tags) continue;
    const hardest = Math.min(...tags.map(t => Number(t[1])));
    const level = (6 - hardest) as 1 | 2 | 3 | 4 | 5;
    return { level, jlptHint: tags.join('-') };
  }
  return null;
}
