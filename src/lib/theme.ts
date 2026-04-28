const THEME_KEY = 'jp343_theme';
const THEMES = ['dark', 'light'] as const;
type Theme = typeof THEMES[number];
const ICONS: Record<Theme, string> = { dark: '\u263E', light: '\u2600' };

export function getCurrentTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  return THEMES.includes(stored as Theme) ? (stored as Theme) : 'dark';
}

export function applyTheme(theme: Theme): void {
  if (theme === 'dark') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

export function cycleTheme(): Theme {
  const current = getCurrentTheme();
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
  return next;
}

export function getThemeIcon(theme: Theme): string {
  return ICONS[theme];
}

export function initThemeToggle(buttonId: string): void {
  const theme = getCurrentTheme();
  applyTheme(theme);
  const btn = document.getElementById(buttonId);
  if (btn) btn.textContent = getThemeIcon(theme);

  btn?.addEventListener('click', () => {
    const next = cycleTheme();
    btn.textContent = getThemeIcon(next);
  });

  window.addEventListener('storage', (e) => {
    if (e.key === THEME_KEY) {
      const t = (e.newValue || 'dark') as Theme;
      applyTheme(THEMES.includes(t) ? t : 'dark');
      if (btn) btn.textContent = getThemeIcon(THEMES.includes(t) ? t : 'dark');
    }
  });
}
