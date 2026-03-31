export function setupThemeToggle(): void {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;

  const saved = localStorage.getItem('jp343_theme');
  if (saved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    btn.textContent = '\u2600';
  }

  btn.addEventListener('click', () => {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    if (isLight) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('jp343_theme', 'dark');
      btn.textContent = '\u263E';
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('jp343_theme', 'light');
      btn.textContent = '\u2600';
    }
  });
}
