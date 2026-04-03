export default defineContentScript({
  matches: ['*://*.disneyplus.com/*'],
  runAt: 'document_start',
  world: 'MAIN',

  main() {
    if ((window as Record<string, unknown>).__jp343DisneyMetaHooked) return;
    (window as Record<string, unknown>).__jp343DisneyMetaHooked = true;

    const nativeParse = JSON.parse;
    const CDN = 'https://prod-ripcut-delivery.disney-plus.net/v1/variant/disney/';

    function extractImageUrl(imageObj: Record<string, unknown>): string | null {
      try {
        const std = imageObj?.standard as Record<string, Record<string, Record<string, string>>> | undefined;
        const tileId = std?.tile?.['1.78']?.imageId || std?.tile?.['0.75']?.imageId;
        if (tileId) return `${CDN}${tileId}/scale?width=400&aspectRatio=1.78&format=webp`;
        const bgId = std?.background?.['1.78']?.imageId;
        if (bgId) return `${CDN}${bgId}/scale?width=400&aspectRatio=1.78&format=webp`;
      } catch { /* ignore */ }
      return null;
    }

    JSON.parse = function (...args: Parameters<typeof JSON.parse>) {
      const parsed = nativeParse.apply(this, args);
      try {
        const exp = parsed?.data?.playerExperience;
        if (exp?.title) {
          window.dispatchEvent(new CustomEvent('jp343-disney-meta', {
            detail: {
              title: exp.title,
              subtitle: exp.subtitle || null,
              thumbnail: extractImageUrl(exp.image) || null
            }
          }));
        }
      } catch { /* ignore */ }
      return parsed;
    };
  }
});
