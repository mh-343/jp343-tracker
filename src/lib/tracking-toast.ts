const TOAST_ID = 'jp343-tracking-toast';
const STYLE_ID = 'jp343-tracking-toast-styles';

interface ToastOptions {
  channelName: string;
  container?: Element | null;
  onAllow: () => void;
  onBlock: () => void;
}

const dismissedChannels = new Set<string>();
let activeChannelId: string | null = null;

function injectStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${TOAST_ID} {
      position: absolute;
      top: 12px;
      right: 12px;
      z-index: 69;
      background: rgba(12, 12, 20, 0.88);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 0, 128, 0.2);
      border-radius: 10px;
      padding: 10px 12px;
      color: #fff;
      font-family: 'Roboto', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 12px;
      max-width: 300px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.5);
      display: flex;
      flex-direction: column;
      gap: 6px;
      animation: jp343-toast-in 0.25s ease-out;
      pointer-events: auto;
      line-height: 1;
    }
    #${TOAST_ID} .jp343-t-head {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #${TOAST_ID} .jp343-t-label {
      color: #999;
      flex: 1;
      font-size: 11px;
    }
    #${TOAST_ID} .jp343-t-x {
      background: none;
      border: none;
      color: #666;
      cursor: pointer;
      font-size: 16px;
      padding: 4px 6px;
      line-height: 1;
      min-width: 28px;
      min-height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #${TOAST_ID} .jp343-t-x:hover { color: #aaa; }
    #${TOAST_ID} .jp343-t-body {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #${TOAST_ID} .jp343-t-ch {
      font-weight: 500;
      color: #eee;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }
    #${TOAST_ID} .jp343-t-btn {
      border: none;
      border-radius: 5px;
      padding: 5px 10px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    #${TOAST_ID} .jp343-t-allow {
      background: rgba(255, 0, 128, 0.18);
      color: #ff4da6;
    }
    #${TOAST_ID} .jp343-t-allow:hover {
      background: rgba(255, 0, 128, 0.3);
    }
    #${TOAST_ID} .jp343-t-block {
      background: rgba(255, 255, 255, 0.08);
      color: #888;
    }
    #${TOAST_ID} .jp343-t-block:hover {
      background: rgba(255, 255, 255, 0.14);
      color: #bbb;
    }
    @media (pointer: coarse) {
      #${TOAST_ID} {
        position: fixed;
        top: auto;
        bottom: 16px;
        left: 12px;
        right: 12px;
        max-width: none;
        padding: 12px 14px;
        gap: 8px;
        z-index: 9999;
      }
      #${TOAST_ID} .jp343-t-btn {
        padding: 12px 18px;
        font-size: 13px;
        min-height: 44px;
      }
      #${TOAST_ID} .jp343-t-x {
        font-size: 18px;
        min-width: 44px;
        min-height: 44px;
      }
      #${TOAST_ID} .jp343-t-ch {
        font-size: 13px;
      }
    }
    @keyframes jp343-toast-in {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
  (doc.head || doc.documentElement).appendChild(style);
}

export function showTrackingToast(channelId: string, options: ToastOptions): void {
  if (dismissedChannels.has(channelId)) return;
  if (activeChannelId === channelId && document.getElementById(TOAST_ID)) return;
  hideTrackingToast();

  const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;
  const container = isTouchDevice ? document.body : (options.container || document.body);
  injectStyles(container.ownerDocument);

  const toast = document.createElement('div');
  toast.id = TOAST_ID;
  toast.addEventListener('pointerdown', (e) => e.stopPropagation());
  toast.addEventListener('click', (e) => e.stopPropagation());

  const head = document.createElement('div');
  head.className = 'jp343-t-head';

  const label = document.createElement('span');
  label.className = 'jp343-t-label';
  label.textContent = 'Japanese channel \u00B7 maybe not Japanese';

  const close = document.createElement('button');
  close.className = 'jp343-t-x';
  close.textContent = '\u2715';
  close.addEventListener('click', () => {
    dismissedChannels.add(channelId);
    hideTrackingToast();
  });

  head.appendChild(label);
  head.appendChild(close);

  const body = document.createElement('div');
  body.className = 'jp343-t-body';

  const ch = document.createElement('span');
  ch.className = 'jp343-t-ch';
  ch.textContent = options.channelName;

  const allow = document.createElement('button');
  allow.className = 'jp343-t-btn jp343-t-allow';
  allow.textContent = 'Allow';
  allow.addEventListener('click', () => {
    dismissedChannels.add(channelId);
    options.onAllow();
    hideTrackingToast();
  });

  const block = document.createElement('button');
  block.className = 'jp343-t-btn jp343-t-block';
  block.textContent = 'Block';
  block.addEventListener('click', () => {
    dismissedChannels.add(channelId);
    options.onBlock();
    hideTrackingToast();
  });

  body.appendChild(ch);
  body.appendChild(allow);
  body.appendChild(block);

  toast.appendChild(head);
  toast.appendChild(body);

  container.appendChild(toast);
  activeChannelId = channelId;
}

export function hideTrackingToast(): void {
  document.getElementById(TOAST_ID)?.remove();
  activeChannelId = null;
}

export function isToastActive(): boolean {
  return activeChannelId !== null && !!document.getElementById(TOAST_ID);
}
