try {
  var t = localStorage.getItem('jp343_theme');
  if (t && t !== 'dark') document.documentElement.setAttribute('data-theme', t);
  var c = localStorage.getItem('jp343_color_theme');
  if (c && c !== 'magenta') document.documentElement.setAttribute('data-color-theme', c);
} catch (e) {}
