export function renderFooter(): void {
  const el = document.getElementById('dashboardFooter');
  if (!el) return;

  const version = document.createElement('span');
  version.textContent = `jp343 Extension v${browser.runtime.getManifest().version}`;

  const links = document.createElement('div');
  links.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:10px;margin-top:6px;';

  const discord = document.createElement('a');
  discord.href = 'https://discord.gg/EA2A93DY';
  discord.target = '_blank';
  discord.title = 'Join our Discord';
  discord.style.cssText = 'color:var(--accent, #e84393);opacity:0.8;transition:opacity 0.2s;display:flex;align-items:center;';
  discord.onmouseover = () => { discord.style.opacity = '1'; };
  discord.onmouseout = () => { discord.style.opacity = '0.5'; };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 127.14 96.36');
  svg.setAttribute('fill', 'currentColor');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z');
  svg.appendChild(path);
  discord.appendChild(svg);

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

  links.appendChild(discord);
  links.appendChild(github);
  links.appendChild(site);
  el.textContent = '';
  el.appendChild(version);
  el.appendChild(links);
}
