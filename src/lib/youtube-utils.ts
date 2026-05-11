export const VIDEO_CARD_SELECTORS = [
  'ytd-rich-item-renderer',
  'ytd-video-renderer',
  'ytd-compact-video-renderer',
  'ytd-grid-video-renderer',
  'ytd-reel-item-renderer',
  'yt-lockup-view-model',
  'ytd-playlist-video-renderer',
  'ytd-movie-renderer',
  'ytm-rich-item-renderer',
  'ytm-compact-video-renderer',
  'ytm-video-with-context-renderer',
  'ytm-reel-item-renderer'
].join(',');

export const CARD_TITLE_SELECTORS: readonly string[] = [
  '#video-title',
  '#video-title-link',
  'a#video-title',
  '#movie-title',
  'a.yt-lockup-metadata-view-model-wiz__title',
  'yt-formatted-string#video-title',
  'span.yt-core-attributed-string',
  'span.ytAttributedStringHost',
  'h3 a'
];

export const WATCH_TITLE_SELECTORS: readonly string[] = [
  'h1.ytd-watch-metadata yt-formatted-string',
  'h1.ytd-video-primary-info-renderer yt-formatted-string',
  '#title h1 yt-formatted-string',
  'ytd-watch-metadata h1 yt-formatted-string',
  '#above-the-fold #title yt-formatted-string',
  'h1.style-scope.ytd-watch-metadata',
  'ytm-slim-video-metadata-section-renderer h2'
];

export function extractVideoIdFromUrl(url?: string): string | null {
  try {
    const href = url ?? window.location.href;
    const parsed = new URL(href, 'https://www.youtube.com');
    const shortsMatch = parsed.pathname.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
    if (shortsMatch) return shortsMatch[1];
    return parsed.searchParams.get('v');
  } catch {
    return null;
  }
}

export function extractVideoIdFromElement(element: Element): string | null {
  const link = element.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
  if (!link) return null;

  const href = link.getAttribute('href');
  if (!href) return null;

  try {
    if (href.includes('/shorts/')) {
      const match = href.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
      return match ? match[1] : null;
    }
    const url = new URL(href, 'https://youtube.com');
    return url.searchParams.get('v');
  } catch {
    return null;
  }
}

export function getCardTitleText(element: Element): string | null {
  for (const selector of CARD_TITLE_SELECTORS) {
    const titleEl = element.querySelector(selector);
    const text = titleEl?.textContent?.trim();
    if (text) return text;
  }
  return null;
}

export function getChannelIdFromElement(element: Element): string | null {
  const link = element.querySelector(
    'ytd-channel-name a, #channel-name a, a[href*="/@"], a[href*="/channel/"]'
  ) as HTMLAnchorElement | null;
  if (!link?.href) return null;
  const channelMatch = link.href.match(/\/channel\/(UC[a-zA-Z0-9_-]+)/);
  if (channelMatch) return channelMatch[1];
  const handleMatch = link.href.match(/\/@([^/?#]+)/);
  if (handleMatch) {
    try { return `@${decodeURIComponent(handleMatch[1])}`; }
    catch { return `@${handleMatch[1]}`; }
  }
  return null;
}

interface OembedResponse {
  title?: string;
}

export async function fetchOembedTitle(videoId: string): Promise<string | null> {
  try {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data: OembedResponse = await response.json();
    return data.title?.trim() || null;
  } catch {
    return null;
  }
}
