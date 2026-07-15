type IconShape = [string, Record<string, string>];

export interface SettingsGroupDef {
  id: string;
  label: string;
  icon: IconShape[];
  build: (groupEl: HTMLElement) => void;
}

export const NAV_ICONS: Record<string, IconShape[]> = {
  general: [['path', { d: 'M22 12h-4l-3 9L9 3l-3 9H2' }]],
  appearance: [
    ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2', ry: '2' }],
    ['circle', { cx: '8.5', cy: '8.5', r: '1.5' }],
    ['path', { d: 'm21 15-5-5L5 21' }]
  ],
  platforms: [
    ['rect', { x: '2', y: '3', width: '20', height: '14', rx: '2' }],
    ['line', { x1: '8', y1: '21', x2: '16', y2: '21' }],
    ['line', { x1: '12', y1: '17', x2: '12', y2: '21' }]
  ],
  integrations: [
    ['path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }],
    ['path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }]
  ],
  data: [['path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }]]
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function makeNavIcon(shapes: IconShape[]): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of shapes) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    svg.appendChild(el);
  }
  return svg;
}

// Persist last section across rebuilds
let activeGroup = '';

export function buildSettingsLayout(panel: HTMLElement, groups: SettingsGroupDef[]): void {
  const layout = document.createElement('div');
  layout.className = 'settings-layout';

  const nav = document.createElement('nav');
  nav.className = 'settings-nav';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', 'Settings sections');

  const groupsWrap = document.createElement('div');
  groupsWrap.className = 'settings-groups';

  const navButtons = new Map<string, HTMLButtonElement>();
  const groupPanels = new Map<string, HTMLElement>();

  function activate(id: string): void {
    activeGroup = id;
    for (const [gid, btn] of navButtons) btn.setAttribute('aria-selected', String(gid === id));
    for (const [gid, el] of groupPanels) el.hidden = gid !== id;
  }

  for (const group of groups) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-nav-btn';
    btn.setAttribute('role', 'tab');
    btn.dataset.group = group.id;
    btn.appendChild(makeNavIcon(group.icon));
    btn.appendChild(document.createTextNode(group.label));
    btn.addEventListener('click', () => activate(group.id));
    nav.appendChild(btn);
    navButtons.set(group.id, btn);

    const groupEl = document.createElement('div');
    groupEl.className = 'settings-group';
    groupEl.dataset.group = group.id;
    groupEl.setAttribute('role', 'tabpanel');
    group.build(groupEl);
    groupsWrap.appendChild(groupEl);
    groupPanels.set(group.id, groupEl);
  }

  layout.appendChild(nav);
  layout.appendChild(groupsWrap);
  panel.appendChild(layout);

  const initial = groups.some(g => g.id === activeGroup) ? activeGroup : groups[0]?.id;
  if (initial) activate(initial);
}
