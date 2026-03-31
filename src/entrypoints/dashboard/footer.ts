export function renderFooter(): void {
  const el = document.getElementById('dashboardFooter');
  if (!el) return;

  const version = document.createElement('span');
  version.textContent = `jp343 Extension v${browser.runtime.getManifest().version}`;

  const links = document.createElement('div');
  links.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:10px;margin-top:6px;';

  const site = document.createElement('a');
  site.href = 'https://jp343.com/?src=d';
  site.target = '_blank';
  site.textContent = 'jp343.com';
  site.style.cssText = 'color:var(--text-secondary);opacity:0.7;font-size:11px;text-decoration:none;transition:opacity 0.2s;';
  site.onmouseover = () => { site.style.opacity = '1'; };
  site.onmouseout = () => { site.style.opacity = '0.5'; };

  const github = document.createElement('a');
  github.href = 'https://github.com/mh-343/jp343-tracker';
  github.target = '_blank';
  github.title = 'Source code on GitHub';
  github.style.cssText = 'color:var(--accent, #e84393);opacity:0.8;transition:opacity 0.2s;display:flex;align-items:center;';
  github.onmouseover = () => { github.style.opacity = '1'; };
  github.onmouseout = () => { github.style.opacity = '0.5'; };
  const ghSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ghSvg.setAttribute('width', '16');
  ghSvg.setAttribute('height', '16');
  ghSvg.setAttribute('viewBox', '0 0 16 16');
  ghSvg.setAttribute('fill', 'currentColor');
  const ghPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  ghPath.setAttribute('d', 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z');
  ghSvg.appendChild(ghPath);
  github.appendChild(ghSvg);

  links.appendChild(github);
  links.appendChild(site);
  el.textContent = '';
  el.appendChild(version);
  el.appendChild(links);
}
