export default defineContentScript({
  matches: ['*://*.netflix.com/*'],
  runAt: 'document_idle',
  world: 'MAIN',
  main() {
    let lastHref = '';
    let extracted = false;

    function extract(): boolean {
      const watchMatch = location.pathname.match(/\/watch\/(\d+)/);
      const watchId = watchMatch ? watchMatch[1] : null;
      if (!watchId) {
        document.documentElement.dataset.jp343SeriesInfo = '';
        return false;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        const vp = w.netflix?.appContext?.state?.playerApp?.getState()?.videoPlayer;
        const meta = vp?.videoMetadata?.[watchId];
        const video = meta?._video?._video ?? null;
        const info = video?.id
          ? { seriesId: String(video.id), title: video.title ?? null, type: video.type ?? null }
          : null;
        if (info) {
          document.documentElement.dataset.jp343SeriesInfo = JSON.stringify(info);
          return true;
        }
        return false;
      } catch (e) {
        document.documentElement.dataset.jp343SeriesInfo = 'null';
        return false;
      }
    }

    setInterval(() => {
      const href = location.href;
      if (href !== lastHref) {
        lastHref = href;
        extracted = false;
        document.documentElement.dataset.jp343SeriesInfo = '';
      }
      if (!extracted && href.includes('/watch/')) {
        extracted = extract();
      }
    }, 200);

    extracted = extract();
  }
});
