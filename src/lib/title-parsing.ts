export interface SeasonOnlyMatch {
  seriesName: string;
  seasonNumber: number;
}

const SEASON_ONLY_PATTERN =
  /^(.+?)(?:\s*[-–:]\s*|\s+)(?:Season|Staffel|Temporada|Saison|シーズン)\s*(\d+)(?:\s+(?:ansehen|anschauen))?$/i;

export function parseSeasonOnly(rawTitle: string): SeasonOnlyMatch | null {
  if (!rawTitle) return null;
  const match = rawTitle.match(SEASON_ONLY_PATTERN);
  if (!match) return null;
  const seriesName = match[1].trim();
  if (!seriesName || !/\p{L}|\p{N}/u.test(seriesName)) return null;
  return {
    seriesName,
    seasonNumber: parseInt(match[2], 10)
  };
}
