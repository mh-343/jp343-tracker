export interface CustomSiteMeta {
  videoId: string;
  title: string;
  url: string;
}

function hashString(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export function resolveCustomSiteMeta(loc: Location): CustomSiteMeta {
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
