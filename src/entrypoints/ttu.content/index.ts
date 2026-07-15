import { startReaderContentLoop } from '../../lib/reader-content';
import { buildTtuSnapshot } from './ttu-parsers';

export default defineContentScript({
  matches: ['*://reader.ttsu.app/*', '*://ttu-ebook.web.app/*'],
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
    window.addEventListener('pagehide', cleanup);

    const DEBUG_MODE = import.meta.env.DEV;
    const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};
    log('[JP343] ttu content script loaded');

    startReaderContentLoop({
      source: 'ttu',
      log,
      intervalIds,
      signal: ac.signal,
      buildSnapshot: buildTtuSnapshot
    });
  }
});
