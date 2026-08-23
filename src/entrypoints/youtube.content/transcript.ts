// youtube transcript acquisition (Paket J)
import type { Json3Transcript } from '../../lib/difficulty-local/types';

interface CaptionDetail {
  videoId: string | null;
  baseUrl: string | null;
  languageCode: string | null;
  kind: string | null;
  lengthSeconds: number | null;
  status?: 'ok' | 'no_track' | 'error';
}

export type TranscriptAcquisition =
  | { status: 'ok'; json3: Json3Transcript; lengthSeconds: number | null }
  | { status: 'no_track' }
  | { status: 'error' };

function injectCaptionScript(): void {
  try {
    const script = document.createElement('script');
    script.src = browser.runtime.getURL('/inject-yt-captions.js');
    document.documentElement.appendChild(script);
  } catch { /* ignore */ }
}

function awaitCaptionEvent(videoId: string, timeoutMs: number): Promise<CaptionDetail | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener('jp343-yt-captions', handler as EventListener);
      resolve(null);
    }, timeoutMs);
    function handler(e: Event): void {
      const detail = (e as CustomEvent<CaptionDetail>).detail;
      if (!detail || detail.videoId !== videoId) return;
      clearTimeout(timer);
      window.removeEventListener('jp343-yt-captions', handler as EventListener);
      resolve(detail);
    }
    window.addEventListener('jp343-yt-captions', handler as EventListener);
  });
}

export async function acquireYoutubeTranscript(videoId: string): Promise<TranscriptAcquisition> {
  const pending = awaitCaptionEvent(videoId, 4000);
  injectCaptionScript();
  const meta = await pending;
  if (!meta) return { status: 'error' };
  if (!meta.baseUrl) return { status: meta.status === 'no_track' ? 'no_track' : 'error' };
  try {
    const res = await fetch(meta.baseUrl + '&fmt=json3');
    if (!res.ok) return { status: 'error' };
    const json3 = await res.json() as Json3Transcript;
    return { status: 'ok', json3, lengthSeconds: meta.lengthSeconds };
  } catch {
    return { status: 'error' };
  }
}
