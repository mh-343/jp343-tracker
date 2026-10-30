// channel of the playing video only

export interface WatchOwner {
  name: string | null;
  url: string | null;
}

const EMPTY_OWNER: WatchOwner = { name: null, url: null };

const OWNER_NAME_SELECTORS = [
  '#channel-name yt-formatted-string#text a',
  '#channel-name yt-formatted-string a',
  'ytd-channel-name yt-formatted-string a',
  'ytd-channel-name a',
  '#channel-name yt-formatted-string#text',
  'ytd-channel-name yt-formatted-string',
  'a'
];

const OWNER_LINK_SELECTORS = [
  '#channel-name a',
  'ytd-channel-name a',
  'a.yt-simple-endpoint'
];

const MOBILE_NAME_SELECTORS = [
  'h3.slim-owner-channel-name span',
  '.slim-owner-channel-name span'
];

const MOBILE_LINK_SELECTORS = [
  'a.slim-owner-icon-and-title[href*="/@"]',
  'a.slim-video-owner-icon'
];

const OWNER_URL_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);

function isChannelHref(href: string): boolean {
  return href.includes('/channel/') || href.includes('/@');
}

function readOwner(root: ParentNode, nameSelectors: readonly string[], linkSelectors: readonly string[]): WatchOwner {
  let name: string | null = null;
  let url: string | null = null;
  for (const selector of nameSelectors) {
    const element = root.querySelector(selector);
    const text = element?.textContent?.trim();
    if (text) {
      name = text;
      if (element instanceof HTMLAnchorElement && element.href && isChannelHref(element.href)) {
        url = element.href;
      }
      break;
    }
  }

  if (!url) {
    for (const selector of linkSelectors) {
      const link = root.querySelector(selector);
      if (link instanceof HTMLAnchorElement && link.href && isChannelHref(link.href)) {
        url = link.href;
        if (!name) name = link.textContent?.trim() || null;
        break;
      }
    }
  }

  return { name, url };
}

function readDesktopOwner(owner: Element | null | undefined): WatchOwner {
  if (!owner) return EMPTY_OWNER;
  // collab: the name line lists several channels
  if (owner.querySelector('yt-avatar-stack-view-model')) return EMPTY_OWNER;
  return readOwner(owner, OWNER_NAME_SELECTORS, OWNER_LINK_SELECTORS);
}

// metadata shows the old owner briefly after navigation
// hidden pages keep channel links of other videos
export function readWatchOwner(videoId: string | null): WatchOwner {
  const metadata = document.querySelectorAll('ytd-watch-metadata');
  if (metadata.length > 0) {
    if (!videoId) return EMPTY_OWNER;
    const current = Array.from(metadata).find(el => el.getAttribute('video-id') === videoId);
    return readDesktopOwner(current?.querySelector('#owner'));
  }
  const owner = document.querySelector('#owner');
  if (owner) return readDesktopOwner(owner);
  return readOwner(document, MOBILE_NAME_SELECTORS, MOBILE_LINK_SELECTORS);
}

// microformat sends http, page links use https
export function ownerUrlFromPlayer(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const url = new URL(raw);
    if (!OWNER_URL_HOSTS.has(url.hostname)) return null;
    if (!/^\/(@[^/]+|channel\/UC[a-zA-Z0-9_-]+)/.test(url.pathname)) return null;
    url.protocol = 'https:';
    return url.href;
  } catch {
    return null;
  }
}

export function channelIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const channelMatch = url.match(/\/channel\/(UC[a-zA-Z0-9_-]+)/);
  if (channelMatch) return channelMatch[1];
  const handleMatch = url.match(/\/@([^/?#]+)/);
  if (!handleMatch) return null;
  try { return `@${decodeURIComponent(handleMatch[1])}`; }
  catch { return `@${handleMatch[1]}`; }
}
