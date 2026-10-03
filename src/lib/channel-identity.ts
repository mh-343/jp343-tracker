export interface ChannelRef {
  channelId: string | null | undefined;
  channelUrl?: string | null;
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);

export function normalizeHandle(raw: string): string {
  let handle = raw.startsWith('@') ? raw.slice(1) : raw;
  try {
    handle = decodeURIComponent(handle);
  } catch {
    /* keep raw */
  }
  return handle.normalize('NFC').toLowerCase();
}

function youtubePath(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return YOUTUBE_HOSTS.has(parsed.hostname) ? parsed.pathname : null;
  } catch {
    return null;
  }
}

export function channelKeys(channelId: string | null | undefined, channelUrl?: string | null): Set<string> {
  const keys = new Set<string>();
  if (channelId) {
    keys.add(`id:${channelId}`);
    if (channelId.startsWith('UC')) keys.add(`uc:${channelId}`);
    else if (channelId.startsWith('@') && channelId.length > 1) keys.add(`h:${normalizeHandle(channelId)}`);
  }
  const path = youtubePath(channelUrl);
  if (path) {
    const uc = path.match(/^\/channel\/(UC[\w-]+)/);
    if (uc) keys.add(`uc:${uc[1]}`);
    const handle = path.match(/^\/@([^/?#]+)/);
    if (handle) keys.add(`h:${normalizeHandle(handle[1])}`);
  }
  return keys;
}

function ucKey(keys: Set<string>): string | null {
  for (const key of keys) if (key.startsWith('uc:')) return key;
  return null;
}

export function sameChannel(a: ChannelRef, b: ChannelRef): boolean {
  const keysA = channelKeys(a.channelId, a.channelUrl);
  const keysB = channelKeys(b.channelId, b.channelUrl);
  if (keysA.size === 0 || keysB.size === 0) return false;
  const ucA = ucKey(keysA);
  const ucB = ucKey(keysB);
  if (ucA && ucB && ucA !== ucB) return false;
  for (const key of keysA) if (keysB.has(key)) return true;
  return false;
}
