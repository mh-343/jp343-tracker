import { isValidImageUrl } from '../../lib/format-utils';

export interface TwitchMetaEvent {
  login: string;
  channelName: string;
  language: string;
  title: string;
  isLive: boolean;
  thumbnail: string;
}

const RESERVED_PATHS = new Set([
  'directory', 'videos', 'settings', 'u', 'p', 'team', 'jobs', 'downloads',
  'turbo', 'subscriptions', 'inventory', 'wallet', 'moderator', 'popout',
  'embed', 'drops', 'prime', 'store', 'friends', 'search', 'following',
  'collections', 'communities', 'dashboard', 'broadcast', 'redeem', 'bits',
  'help', 'partner', 'creatorcamp', 'event', 'login', 'signup', 'products'
]);

export function parseChannelLogin(pathname: string): string | null {
  const match = pathname.match(/^\/([a-zA-Z0-9_]{2,25})\/?$/);
  if (!match) return null;
  const login = match[1].toLowerCase();
  if (RESERVED_PATHS.has(login)) return null;
  return login;
}

export function parseTwitchMetaEvent(detail: unknown): TwitchMetaEvent | null {
  if (!detail || typeof detail !== 'object') return null;
  const d = detail as Record<string, unknown>;
  if (typeof d.login !== 'string' || !d.login) return null;
  const cap = (value: unknown, max: number): string =>
    typeof value === 'string' ? value.slice(0, max) : '';
  const login = d.login.slice(0, 30).toLowerCase();
  const rawThumb = cap(d.thumbnail, 400);
  return {
    login,
    channelName: cap(d.channelName, 100) || login,
    language: cap(d.language, 16).toLowerCase(),
    title: cap(d.title, 300),
    isLive: d.isLive === true,
    thumbnail: isValidImageUrl(rawThumb) ? rawThumb : ''
  };
}
