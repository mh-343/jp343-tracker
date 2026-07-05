import { createDebugLogger } from '../../lib/debug-logger';
import { buildSnapshot } from './mokuro-parsers';

export default defineContentScript({
  matches: ['*://reader.mokuro.app/*'],
  registration: 'runtime',
  runAt: 'document_idle',

  main() {
    const observers: MutationObserver[] = [];
    const intervalIds: ReturnType<typeof setInterval>[] = [];
    const ac = new AbortController();
    function cleanup(): void {
      observers.forEach(o => o.disconnect());
      intervalIds.forEach(clearInterval);
      observers.length = 0;
      intervalIds.length = 0;
      ac.abort();
    }

    const { log } = createDebugLogger('mokuro');
    log('[JP343] Mokuro content script loaded');

    async function sendMessage(type: string, data?: Record<string, unknown>): Promise<void> {
      try {
        await browser.runtime.sendMessage({ type, platform: 'mokuro', ...data });
      } catch (error) {
        if (error instanceof Error && error.message.includes('Extension context invalidated')) return;
        log('[JP343] Message error:', error);
      }
    }

    function pushSnapshot(): void {
      try {
        const volumes = buildSnapshot(
          window.localStorage.getItem('volumes'),
          window.localStorage.getItem('profiles'),
          window.localStorage.getItem('currentProfile')
        );
        if (Object.keys(volumes).length === 0) return;
        void sendMessage('MOKURO_SYNC', { volumes });
      } catch (error) {
        log('[JP343] Mokuro snapshot failed:', error);
      }
    }

    browser.runtime.onMessage.addListener((message) => {
      if (message?.type === 'GET_CONTENT_TIME') return Promise.resolve({ alive: true });
      return undefined;
    });

    pushSnapshot();
    intervalIds.push(setInterval(pushSnapshot, 60000));

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) pushSnapshot();
    }, { signal: ac.signal });
    window.addEventListener('pagehide', () => {
      pushSnapshot();
      cleanup();
    }, { signal: ac.signal });
  }
});
