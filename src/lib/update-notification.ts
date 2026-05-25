const NOTIFICATION_ID = 'jp343-update-notification';
const STYLE_ID = 'jp343-update-notification-styles';

let dismissed = false;
let listenerAttached = false;

function injectStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${NOTIFICATION_ID} {
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 2147483647;
      background: rgba(12, 12, 20, 0.92);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 0, 128, 0.2);
      border-radius: 10px;
      padding: 10px 12px;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
      max-width: 360px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      gap: 10px;
      animation: jp343-notif-in 0.25s ease-out;
      pointer-events: auto;
      line-height: 1.3;
    }
    #${NOTIFICATION_ID} .jp343-n-reload {
      background: rgba(255, 0, 128, 0.18);
      color: #ff4da6;
      border: none;
      padding: 6px 12px;
      border-radius: 5px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    #${NOTIFICATION_ID} .jp343-n-reload:hover {
      background: rgba(255, 0, 128, 0.3);
    }
    #${NOTIFICATION_ID} .jp343-n-close {
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
      flex-shrink: 0;
    }
    #${NOTIFICATION_ID} .jp343-n-close:hover { color: #aaa; }
    @media (pointer: coarse) {
      #${NOTIFICATION_ID} {
        top: auto;
        bottom: 16px;
        left: 12px;
        right: 12px;
        max-width: none;
        padding: 12px 14px;
        gap: 8px;
      }
      #${NOTIFICATION_ID} .jp343-n-reload {
        padding: 12px 18px;
        font-size: 13px;
        min-height: 44px;
      }
      #${NOTIFICATION_ID} .jp343-n-close {
        font-size: 18px;
        min-width: 44px;
        min-height: 44px;
      }
    }
    @keyframes jp343-notif-in {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
  (doc.head || doc.documentElement).appendChild(style);
}

function getNotificationParent(): Element {
  return document.fullscreenElement || document.body;
}

function handleFullscreenChange(): void {
  const el = document.getElementById(NOTIFICATION_ID);
  if (!el) return;
  getNotificationParent().appendChild(el);
}

export function showUpdateNotification(): void {
  if (dismissed) return;
  try { if (window !== window.top) return; } catch { return; }
  if (document.getElementById(NOTIFICATION_ID)) return;

  injectStyles(document);

  const container = document.createElement('div');
  container.id = NOTIFICATION_ID;

  const text = document.createElement('span');
  text.textContent = 'jp343 was updated. Reload to resume tracking.';

  const reloadBtn = document.createElement('button');
  reloadBtn.className = 'jp343-n-reload';
  reloadBtn.textContent = 'Reload';
  reloadBtn.addEventListener('click', () => location.reload());

  const closeBtn = document.createElement('button');
  closeBtn.className = 'jp343-n-close';
  closeBtn.textContent = '\u2715';
  closeBtn.addEventListener('click', () => {
    dismissed = true;
    container.remove();
  });

  container.append(text, reloadBtn, closeBtn);
  getNotificationParent().appendChild(container);

  if (!listenerAttached) {
    listenerAttached = true;
    document.addEventListener('fullscreenchange', handleFullscreenChange);
  }
}
