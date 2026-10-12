import type { ReaderState, ReaderVolumeSnapshot } from '../../types';
import { startReaderContentLoop } from '../../lib/reader-content';
import { buildTtuSnapshot, openBookId } from './ttu-parsers';

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

    const contentHashes = new Map<number, string | null>();
    let building: Promise<Record<string, ReaderVolumeSnapshot>> | null = null;

    async function knownContentIds(): Promise<Record<string, string>> {
      try {
        const reply = await browser.runtime.sendMessage({ type: 'READER_GET_STATE', source: 'ttu' }) as
          { data?: { readerState?: Partial<ReaderState> } } | undefined;
        return reply?.data?.readerState?.contentIds ?? {};
      } catch {
        return {};
      }
    }

    async function buildSnapshot(): Promise<Record<string, ReaderVolumeSnapshot>> {
      try {
        if (!browser.runtime?.id) return {};
      } catch {
        return {};
      }
      return buildTtuSnapshot({ known: await knownContentIds(), hashes: contentHashes, openDataId: openBookId(location.href) });
    }

    startReaderContentLoop({
      source: 'ttu',
      log,
      intervalIds,
      signal: ac.signal,
      // first run reads every book once
      buildSnapshot: () => (building ??= buildSnapshot().finally(() => { building = null; }))
    });
  }
});
