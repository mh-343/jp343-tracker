// youtube transcript acquisition (Paket J)
import type { Json3Transcript } from '../../lib/difficulty-local/types';

interface CaptionDetail {
  videoId: string | null;
  baseUrl: string | null;
  languageCode: string | null;
  kind: string | null;
  lengthSeconds: number | null;
}

export interface TranscriptResult {
  json3: Json3Transcript;
  lengthSeconds: number | null;
}

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

export async function acquireYoutubeTranscript(videoId: string): Promise<TranscriptResult | null> {
  const pending = awaitCaptionEvent(videoId, 4000);
  injectCaptionScript();
  const meta = await pending;
  if (!meta || !meta.baseUrl) return null;
  try {
    const res = await fetch(meta.baseUrl + '&fmt=json3');
    if (!res.ok) return null;
    const json3 = await res.json() as Json3Transcript;
    return { json3, lengthSeconds: meta.lengthSeconds };
  } catch {
    return null;
  }
}
