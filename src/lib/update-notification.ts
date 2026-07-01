const NOTIFICATION_ID = 'jp343-update-notification';
const STYLE_ID = 'jp343-update-notification-styles';
const SVG_NS = 'http://www.w3.org/2000/svg';
const ACCENT = '#ffb020';

let listenerAttached = false;

function injectStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  // No auto-dismiss timer.
  style.textContent = `
    #${NOTIFICATION_ID} {
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 2147483647;
      background: rgba(12, 12, 20, 0.97);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-left: 4px solid ${ACCENT};
      border-radius: 12px;
      padding: 14px;
      color: #e6e6ea;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      max-width: 380px;
      box-shadow: 0 8px 28px rgba(0,0,0,0.55);
      display: flex;
      flex-direction: column;
      gap: 12px;
      pointer-events: auto;
      line-height: 1.4;
    }
    #${NOTIFICATION_ID} .jp343-n-top {
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }
    #${NOTIFICATION_ID} .jp343-n-icon {
      flex-shrink: 0;
      width: 22px;
      height: 22px;
      margin-top: 1px;
      color: ${ACCENT};
    }
    #${NOTIFICATION_ID} .jp343-n-icon svg { width: 22px; height: 22px; display: block; }
    #${NOTIFICATION_ID} .jp343-n-text { flex: 1; min-width: 0; }
    #${NOTIFICATION_ID} .jp343-n-title {
      font-size: 13.5px;
      font-weight: 700;
      color: #ffce8a;
      margin: 0 0 3px;
    }
    #${NOTIFICATION_ID} .jp343-n-body { color: #c9c9d2; font-size: 12.5px; }
    #${NOTIFICATION_ID} .jp343-n-reload {
      background: #e91e8b;
      color: #fff;
      border: none;
      padding: 9px 14px;
      border-radius: 7px;
      cursor: pointer;
      font-size: 12.5px;
      font-weight: 600;
      white-space: nowrap;
      align-self: flex-start;
      transition: background 0.15s;
    }
    #${NOTIFICATION_ID} .jp343-n-reload:hover { background: #c4167a; }
    #${NOTIFICATION_ID} .jp343-n-close {
      background: none;
      border: none;
      color: #9aa0aa;
      cursor: pointer;
      font-size: 16px;
      padding: 4px 6px;
      line-height: 1;
      min-width: 28px;
      min-height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    #${NOTIFICATION_ID} .jp343-n-close:hover { color: #d8dade; }
    #${NOTIFICATION_ID} .jp343-n-chip {
      display: none;
      align-items: center;
      gap: 8px;
      background: none;
      border: none;
      color: #e6e6ea;
      cursor: pointer;
      font-family: inherit;
      font-size: 12.5px;
      font-weight: 600;
      padding: 0;
    }
    #${NOTIFICATION_ID} .jp343-n-chip-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: ${ACCENT};
      flex-shrink: 0;
    }
    #${NOTIFICATION_ID} :focus-visible {
      outline: 2px solid ${ACCENT};
      outline-offset: 2px;
    }
    #${NOTIFICATION_ID}.jp343-n-collapsed { padding: 10px 14px; max-width: none; }
    #${NOTIFICATION_ID}.jp343-n-collapsed .jp343-n-top,
    #${NOTIFICATION_ID}.jp343-n-collapsed .jp343-n-reload { display: none; }
    #${NOTIFICATION_ID}.jp343-n-collapsed .jp343-n-chip { display: flex; }
    @media (pointer: coarse) {
      #${NOTIFICATION_ID} {
        top: calc(16px + env(safe-area-inset-top));
        left: 12px;
        right: 12px;
        max-width: none;
      }
      #${NOTIFICATION_ID} .jp343-n-reload {
        align-self: stretch;
        text-align: center;
        padding: 13px 18px;
        font-size: 13px;
        min-height: 44px;
      }
      #${NOTIFICATION_ID} .jp343-n-close {
        font-size: 18px;
        min-width: 44px;
        min-height: 44px;
      }
    }
    @media (prefers-reduced-motion: no-preference) {
      #${NOTIFICATION_ID} { animation: jp343-notif-in 0.28s cubic-bezier(.2,.8,.2,1); }
      #${NOTIFICATION_ID} .jp343-n-icon { animation: jp343-notif-pulse 0.6s ease-in-out 0.3s 3; }
    }
    @keyframes jp343-notif-in {
      from { opacity: 0; transform: translateY(-10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes jp343-notif-pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.18); opacity: 0.7; }
    }
  `;
  (doc.head || doc.documentElement).appendChild(style);
}

function createReloadIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const arc = document.createElementNS(SVG_NS, 'path');
  arc.setAttribute('d', 'M21 12a9 9 0 1 1-2.64-6.36');
  const head = document.createElementNS(SVG_NS, 'path');
  head.setAttribute('d', 'M21 3v6h-6');
  svg.append(arc, head);
  return svg;
}

function getNotificationParent(): Element {
  return document.fullscreenElement || document.body;
}

function handleFullscreenChange(): void {
  // Move node; do not re-announce.
  const el = document.getElementById(NOTIFICATION_ID);
  if (!el) return;
  getNotificationParent().appendChild(el);
}

export function showUpdateNotification(): void {
  try { if (window !== window.top) return; } catch { return; }
  if (document.getElementById(NOTIFICATION_ID)) return;

  injectStyles(document);

  const container = document.createElement('div');
  container.id = NOTIFICATION_ID;
  container.addEventListener('pointerdown', (e) => e.stopPropagation());
  container.addEventListener('click', (e) => e.stopPropagation());

  const top = document.createElement('div');
  top.className = 'jp343-n-top';

  const icon = document.createElement('span');
  icon.className = 'jp343-n-icon';
  icon.appendChild(createReloadIcon());

  // Fill next frame so SR announces.
  const text = document.createElement('div');
  text.className = 'jp343-n-text';
  text.setAttribute('role', 'alert');
  text.setAttribute('aria-atomic', 'true');

  const closeBtn = document.createElement('button');
  closeBtn.className = 'jp343-n-close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Minimize');

  top.append(icon, text, closeBtn);

  const reloadBtn = document.createElement('button');
  reloadBtn.className = 'jp343-n-reload';
  reloadBtn.textContent = 'Reload to keep tracking';
  reloadBtn.addEventListener('click', () => location.reload());

  const chip = document.createElement('button');
  chip.className = 'jp343-n-chip';
  const dot = document.createElement('span');
  dot.className = 'jp343-n-chip-dot';
  const chipLabel = document.createElement('span');
  chipLabel.textContent = 'Tracking paused';
  chip.append(dot, chipLabel);

  // X minimizes to a re-expandable chip.
  closeBtn.addEventListener('click', () => container.classList.add('jp343-n-collapsed'));
  chip.addEventListener('click', () => container.classList.remove('jp343-n-collapsed'));

  container.append(top, reloadBtn, chip);
  getNotificationParent().appendChild(container);

  requestAnimationFrame(() => {
    const title = document.createElement('div');
    title.className = 'jp343-n-title';
    title.textContent = 'Time tracking paused on this tab';
    const body = document.createElement('div');
    body.className = 'jp343-n-body';
    body.textContent = 'jp343 updated and stopped counting this video. Reload this tab to resume tracking.';
    text.append(title, body);
  });

  if (!listenerAttached) {
    listenerAttached = true;
    document.addEventListener('fullscreenchange', handleFullscreenChange);
  }
}
