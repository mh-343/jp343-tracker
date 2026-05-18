import { STORAGE_KEYS } from '../../types';
import type { JP343UserState } from '../../types';
import { isValidImageUrl } from '../../lib/format-utils';

interface NewsItem {
  id: string;
  text: string;
  type: 'info' | 'warning' | 'critical';
  audience?: 'all' | 'logged_in' | 'logged_out';
  link_url?: string;
  link_text?: string;
  image_url?: string;
}

type NewsApiResponse = NewsItem[] | NewsItem | Record<string, never>;

function normalizeResponse(data: NewsApiResponse): NewsItem[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && 'id' in data && 'text' in data) {
    return [data as NewsItem];
  }
  return [];
}

function buildBanner(item: NewsItem): HTMLElement {
  const banner = document.createElement('div');
  banner.className = 'news-banner';

  const inner = document.createElement('div');
  inner.className = 'news-banner-inner';

  const icon = document.createElement('span');
  icon.className = 'news-banner-icon';
  const icons: Record<string, string> = { info: '\u2139', warning: '\u26A0', critical: '\u274C' };
  icon.textContent = icons[item.type] || '\u2139';
  if (item.type === 'warning') icon.style.color = 'var(--orange)';
  if (item.type === 'critical') icon.style.color = 'var(--red)';

  const text = document.createElement('span');
  text.className = 'news-banner-text';
  text.textContent = item.text;

  if (item.link_url && /^https?:\/\//.test(item.link_url)) {
    const link = document.createElement('a');
    link.href = item.link_url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = item.link_text || 'Learn more';
    text.append(' ', link);
  }

  const closeBtn = document.createElement('button');
  closeBtn.className = 'news-banner-close';
  closeBtn.title = 'Dismiss';
  closeBtn.textContent = '\u00D7';

  inner.append(icon, text, closeBtn);
  banner.appendChild(inner);

  if (item.image_url && isValidImageUrl(item.image_url)) {
    const imgWrap = document.createElement('div');
    imgWrap.className = 'news-banner-image';
    const img = document.createElement('img');
    img.src = item.image_url;
    img.alt = '';
    img.loading = 'lazy';
    imgWrap.appendChild(img);
    banner.appendChild(imgWrap);
  }

  return banner;
}

export async function loadNews(): Promise<void> {
  try {
    const extVersion = browser.runtime.getManifest().version;
    const url = `https://jp343.com/wp-json/jp343/v1/extension/news?multi=1&ext_version=${encodeURIComponent(extVersion)}`;
    const res = await fetch(url);
    if (!res.ok) return;

    const raw: NewsApiResponse = await res.json();
    const items = normalizeResponse(raw);
    if (items.length === 0) return;

    const stored = await browser.storage.local.get(STORAGE_KEYS.USER);
    const userState: JP343UserState | null = stored[STORAGE_KEYS.USER] || null;
    const isLoggedIn = !!userState?.isLoggedIn;

    const container = document.getElementById('newsContainer');
    if (!container) return;

    let shown = 0;
    for (const item of items) {
      if (shown >= 3) break;
      if (!item.id || !item.text) continue;
      if (localStorage.getItem(`jp343_news_dismissed_${item.id}`)) continue;

      if (item.audience && item.audience !== 'all') {
        if (item.audience === 'logged_in' && !isLoggedIn) continue;
        if (item.audience === 'logged_out' && isLoggedIn) continue;
      }

      const banner = buildBanner(item);
      const closeBtn = banner.querySelector('.news-banner-close')!;
      closeBtn.addEventListener('click', () => {
        banner.remove();
        localStorage.setItem(`jp343_news_dismissed_${item.id}`, '1');
      });

      container.appendChild(banner);
      shown++;
    }
  } catch { /* offline or server error */ }
}
