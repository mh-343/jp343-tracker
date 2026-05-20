import { parseSeasonOnly } from '../../lib/title-parsing';

export interface NetflixMetadata {
  title: string;
  episodeTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  isMovie: boolean;
  thumbnailUrl: string | null;
}

const GENERIC_TITLES = new Set([
  'netflix', 'home', 'startseite', 'browse',
  'filme', 'serien', 'meine liste', 'neu und beliebt', 'kategorien',
  'movies', 'tv shows', 'my list', 'new & popular', 'categories',
  'trending now', 'top 10'
]);

export function isGenericPageTitle(title: string): boolean {
  if (!title || title === 'Netflix Content') return true;
  const lower = title.toLowerCase().trim();
  if (lower.length < 2) return true;
  if (lower.includes('netflix home') || lower.includes('browse')) return true;
  return GENERIC_TITLES.has(lower);
}

export function parseNetflixTitle(rawTitle: string): Partial<NetflixMetadata> {
  const result: Partial<NetflixMetadata> = {
    title: rawTitle,
    isMovie: true
  };

  const colonPattern = /^(.+?):\s*S(\d+):E(\d+)\s*(.*)$/i;
  let match = rawTitle.match(colonPattern);
  if (match) {
    result.title = match[1].trim();
    result.seasonNumber = parseInt(match[2], 10);
    result.episodeNumber = parseInt(match[3], 10);
    result.episodeTitle = match[4].trim() || null;
    result.isMovie = false;
    return result;
  }

  const longPattern = /^(.+?)\s*[-–]\s*Season\s*(\d+).*Episode\s*(\d+)(.*)$/i;
  match = rawTitle.match(longPattern);
  if (match) {
    result.title = match[1].trim();
    result.seasonNumber = parseInt(match[2], 10);
    result.episodeNumber = parseInt(match[3], 10);
    result.episodeTitle = match[4].replace(/^[\s:–-]+/, '').trim() || null;
    result.isMovie = false;
    return result;
  }

  const inlinePattern = /S(\d+)\s*E(\d+)/i;
  match = rawTitle.match(inlinePattern);
  if (match) {
    result.seasonNumber = parseInt(match[1], 10);
    result.episodeNumber = parseInt(match[2], 10);
    const titlePart = rawTitle.substring(0, rawTitle.indexOf(match[0])).trim();
    if (titlePart) {
      result.title = titlePart.replace(/[-–:]\s*$/, '').trim();
    }
    result.isMovie = false;
    return result;
  }

  const flgPattern = /^(.+?)\s+Flg\.\s*(\d+)\s+(.+)$/i;
  match = rawTitle.match(flgPattern);
  if (match) {
    result.title = match[1].trim();
    result.episodeNumber = parseInt(match[2], 10);
    result.episodeTitle = match[3].trim();
    result.isMovie = false;
    return result;
  }

  const flgShortPattern = /^(.+?)\s+Flg\.\s*(\d+)$/i;
  match = rawTitle.match(flgShortPattern);
  if (match) {
    result.title = match[1].trim();
    result.episodeNumber = parseInt(match[2], 10);
    result.isMovie = false;
    return result;
  }

  const folgePattern = /^(.+?)\s+Folge\s*(\d+)\s+(.+)$/i;
  match = rawTitle.match(folgePattern);
  if (match) {
    result.title = match[1].trim();
    result.episodeNumber = parseInt(match[2], 10);
    result.episodeTitle = match[3].trim();
    result.isMovie = false;
    return result;
  }

  const epPattern = /^(.+?)\s+(?:Ep\.?|Episode)\s*(\d+)\s+(.+)$/i;
  match = rawTitle.match(epPattern);
  if (match) {
    result.title = match[1].trim();
    result.episodeNumber = parseInt(match[2], 10);
    result.episodeTitle = match[3].trim();
    result.isMovie = false;
    return result;
  }

  const seasonOnly = parseSeasonOnly(rawTitle);
  if (seasonOnly) {
    result.title = seasonOnly.seriesName;
    result.seasonNumber = seasonOnly.seasonNumber;
    result.isMovie = false;
    return result;
  }

  return result;
}

export function parseEpisodeInfo(text: string): { seasonNumber: number | null; episodeNumber: number | null; episodeTitle: string | null } {
  const result = { seasonNumber: null as number | null, episodeNumber: null as number | null, episodeTitle: null as string | null };

  const patterns = [
    /S(\d+):?E(\d+)/i,
    /Season\s*(\d+).*Episode\s*(\d+)/i,
    /Staffel\s*(\d+).*Folge\s*(\d+)/i,
    /(\d+)x(\d+)/,
    /Flg\.\s*(\d+)/i,
    /Folge\s*(\d+)/i,
    /Ep\.?\s*(\d+)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      if (match[2]) {
        result.seasonNumber = parseInt(match[1], 10);
        result.episodeNumber = parseInt(match[2], 10);
      } else {
        result.episodeNumber = parseInt(match[1], 10);
      }
      const rest = text.replace(match[0], '').replace(/^[\s:–-]+/, '').trim();
      if (rest && rest.length > 2) {
        result.episodeTitle = rest;
      }
      break;
    }
  }

  return result;
}

export function getVideoId(): string | null {
  const match = window.location.pathname.match(/\/watch\/(\d+)/);
  return match ? match[1] : null;
}
