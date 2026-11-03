export interface CustomSiteMeta {
  videoId: string;
  title: string;
  url: string;
}

export interface MetaSource {
  hostname: string;
  pathname: string;
  origin: string;
  search?: string;
}

// subframes label by the embedding page
export function resolveMetaSource(
  loc: MetaSource,
  isTopFrame: boolean,
  referrer: string
): MetaSource {
  if (isTopFrame || !referrer) return loc;
  try {
    const url = new URL(referrer);
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      return { hostname: url.hostname, pathname: url.pathname, origin: url.origin, search: url.search };
    }
  } catch { /* invalid */ }
  return loc;
}

function hashString(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

// decoration loops; muted alone can be content
export function isDecorativeVideo(v: HTMLVideoElement): boolean {
  return v.loop;
}

export function isAudibleVideo(v: HTMLVideoElement): boolean {
  return !v.muted && v.volume > 0;
}

// muted play this long counts as watching
export const MUTED_START_MS = 30_000;

// audible non-loop videos win over muted ones
export function videoCandidates(vids: HTMLVideoElement[]): HTMLVideoElement[] {
  const content = vids.filter(v => !isDecorativeVideo(v));
  const audible = content.filter(isAudibleVideo);
  return audible.length > 0 ? audible : content;
}

export const EPISODE_QUERY_KEYS = new Set([
  'ep', 'eps', 'episode', 'episodes', 'ep_id', 'epid', 'episode_id', 'episodeid',
  'ep_no', 'ep_num', 'episode_no', 'episode_num', 'episode_number'
]);

export const ROUTE_WORDS = new Set([
  'watch', 'play', 'player', 'video', 'videos', 'v', 'stream', 'streaming', 'view',
  'embed', 'e', 'ep', 'episode', 'episodes', 'anime', 'drama', 'dramas', 'series',
  'show', 'shows', 'movie', 'movies', 'tv', 'title', 'titles', 'media', 'vod', 'w', 'index'
]);

export function hasEpisodeQuery(search: string | undefined): boolean {
  if (!search) return false;
  for (const [key, value] of new URLSearchParams(search)) {
    if (EPISODE_QUERY_KEYS.has(key.toLowerCase()) && value.trim() !== '') return true;
  }
  return false;
}

export function isRouteWord(segment: string): boolean {
  return ROUTE_WORDS.has(segment.toLowerCase().replace(/\.[a-z0-9]{2,5}$/, ''));
}

// episode in the query: the last segment can be the series
function seriesSegmentsOf(segments: string[], search: string | undefined): string[] {
  const series = segments.slice(0, -1);
  if (segments.length === 0 || !hasEpisodeQuery(search)) return series;
  if (isRouteWord(segments[segments.length - 1])) return series;
  const catchAll = series.length === 0 || isRouteWord(series[series.length - 1]);
  return catchAll ? segments : series;
}

export function resolveCustomSiteMeta(loc: MetaSource): CustomSiteMeta {
  const host = loc.hostname.replace(/^www\./, '');
  const segments = loc.pathname.split('/').filter(Boolean);
  const seriesSegments = seriesSegmentsOf(segments, loc.search);
  const label = seriesSegments.length ? seriesSegments[seriesSegments.length - 1] : host;
  const seriesKey = seriesSegments.length ? host + '/' + seriesSegments.join('/') : host;
  const videoId = 'cs_' + hashString(seriesKey);
  return {
    videoId,
    title: label,
    url: loc.origin + '/#' + videoId
  };
}
