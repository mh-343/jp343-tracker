import { STORAGE_KEYS } from '../../types';
import type { JP343UserState } from '../../types';

interface NewsResponse {
  id?: string;
  text?: string;
  type?: 'info' | 'warning' | 'critical';
  audience?: 'all' | 'logged_in' | 'logged_out';
  min_version?: string;
  link_url?: string;
  link_text?: string;
}

export async function loadNews(): Promise<void> {
  try {
    const res = await fetch('https://jp343.com/wp-json/jp343/v1/extension/news');
    if (!res.ok) return;
    const data: NewsResponse = await res.json();
    if (!data.id || !data.text) return;
    if (data.min_version) {
      const current = browser.runtime.getManifest().version;
      if (current.localeCompare(data.min_version, undefined, { numeric: true }) < 0) return;
    }
    if (localStorage.getItem(`jp343_news_dismissed_${data.id}`)) return;

    if (data.audience && data.audience !== 'all') {
      const stored = await browser.storage.local.get(STORAGE_KEYS.USER);
      const userState: JP343UserState | null = stored[STORAGE_KEYS.USER] || null;
      const isLoggedIn = !!userState?.isLoggedIn;
      if (data.audience === 'logged_in' && !isLoggedIn) return;
      if (data.audience === 'logged_out' && isLoggedIn) return;
    }

    const banner = document.getElementById('newsBanner');
    const textEl = document.getElementById('newsBannerText');
    const closeBtn = document.getElementById('newsBannerClose');
    const iconEl = banner?.querySelector('.news-banner-icon');
    if (!banner || !textEl || !closeBtn) return;

    textEl.textContent = data.text;
    if (data.link_url) {
      const link = document.createElement('a');
      link.href = data.link_url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = data.link_text || 'Learn more';
      textEl.append(' ', link);
    }
    if (iconEl) {
      const icons: Record<string, string> = { info: '\u2139', warning: '\u26A0', critical: '\u274C' };
      iconEl.textContent = icons[data.type || 'info'] || '\u2139';
      if (data.type === 'warning') (iconEl as HTMLElement).style.color = 'var(--orange)';
      if (data.type === 'critical') (iconEl as HTMLElement).style.color = 'var(--red)';
    }
    banner.style.display = '';
    closeBtn.addEventListener('click', () => {
      banner.style.display = 'none';
      localStorage.setItem(`jp343_news_dismissed_${data.id}`, '1');
    });
  } catch { /* offline or server error */ }
}
