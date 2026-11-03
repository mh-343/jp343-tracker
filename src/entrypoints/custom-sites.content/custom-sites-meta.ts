export interface CustomSiteMeta {
  videoId: string;
  title: string;
  url: string;
}

export interface MetaSource {
  hostname: string;
  pathname: string;
  origin: string;
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
      return { hostname: url.hostname, pathname: url.pathname, origin: url.origin };
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

export function resolveCustomSiteMeta(loc: MetaSource): CustomSiteMeta {
  const host = loc.hostname.replace(/^www\./, '');
  const segments = loc.pathname.split('/').filter(Boolean);
  const seriesSegments = segments.slice(0, -1);
  const label = seriesSegments.length ? seriesSegments[seriesSegments.length - 1] : host;
  const seriesKey = seriesSegments.length ? host + '/' + seriesSegments.join('/') : host;
  const videoId = 'cs_' + hashString(seriesKey);
  return {
    videoId,
    title: label,
    url: loc.origin + '/#' + videoId
  };
}
