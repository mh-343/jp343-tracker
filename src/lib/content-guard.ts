import { removeUpdateNotification, markContentScriptAlive } from './update-notification';

// Per-frame sentinel on window so a
// background reinject can clear it.
export function claimContentScript(key: string): boolean {
  const w = window as unknown as { __jp343Claimed?: Record<string, boolean> };
  w.__jp343Claimed = w.__jp343Claimed || {};
  if (w.__jp343Claimed[key]) return false;
  w.__jp343Claimed[key] = true;
  heartbeat();
  const id = setInterval(heartbeat, 2000);
  window.addEventListener('pagehide', () => clearInterval(id), { once: true });
  return true;
}

// While the context is live, keep the
// stale-update banner suppressed.
function heartbeat(): void {
  try {
    if (browser.runtime?.id) {
      markContentScriptAlive();
      removeUpdateNotification();
    }
  } catch { /* context gone */ }
}
