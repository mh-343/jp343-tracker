export interface DifficultySeed {
  level: 1 | 2 | 3 | 4 | 5;
  jlptHint: string;
  mixed?: boolean;
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
