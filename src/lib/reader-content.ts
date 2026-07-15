import type { ReaderVolumeSnapshot } from '../types';

const POLL_MS = 30000;

export interface ReaderContentHooks {
  source: string;
  buildSnapshot: () => Record<string, ReaderVolumeSnapshot> | Promise<Record<string, ReaderVolumeSnapshot>>;
  log: (...args: unknown[]) => void;
  intervalIds: ReturnType<typeof setInterval>[];
  signal: AbortSignal;
}

// Shared reader poll loop
export function startReaderContentLoop(hooks: ReaderContentHooks): void {
  const { source, buildSnapshot, log, intervalIds, signal } = hooks;

  async function sendMessage(type: string, data?: Record<string, unknown>): Promise<void> {
    try {
      await browser.runtime.sendMessage({ type, source, ...data });
    } catch (error) {
      if (error instanceof Error && error.message.includes('Extension context invalidated')) return;
      log('[JP343] Message error:', error);
    }
  }

  async function pushSnapshot(): Promise<void> {
    try {
      const volumes = await buildSnapshot();
      if (Object.keys(volumes).length === 0) return;
      await sendMessage('READER_SNAPSHOT', { volumes });
    } catch (error) {
      log('[JP343] Reader snapshot failed:', error);
    }
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === 'GET_CONTENT_TIME') return Promise.resolve({ alive: true });
    return undefined;
  });

  void pushSnapshot();
  intervalIds.push(setInterval(() => { void pushSnapshot(); }, POLL_MS));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void pushSnapshot();
  }, { signal });
  window.addEventListener('pagehide', () => {
    void pushSnapshot();
  }, { signal });
}
