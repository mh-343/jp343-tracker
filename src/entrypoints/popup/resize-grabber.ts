import { STORAGE_KEYS } from '../../types';

const POPUP_MIN_HEIGHT = 450;
const POPUP_MAX_HEIGHT = 600;

export function initResizeGrabber(grabber: HTMLElement): void {
  browser.storage.local.get(STORAGE_KEYS.POPUP_HEIGHT).then(result => {
    const stored = result[STORAGE_KEYS.POPUP_HEIGHT];
    if (typeof stored === 'number' && stored >= POPUP_MIN_HEIGHT && stored <= POPUP_MAX_HEIGHT) {
      document.body.style.height = `${stored}px`;
    }
  });

    let isDragging = false;

    function saveHeight(): void {
      const h = document.body.offsetHeight;
      browser.storage.local.set({ [STORAGE_KEYS.POPUP_HEIGHT]: h }).catch(() => {});
    }

    function startDrag(startY: number): void {
      const startHeight = document.body.offsetHeight;
      isDragging = true;
      grabber.classList.add('dragging');

      function applyDelta(currentY: number): void {
        const delta = currentY - startY;
        const newHeight = Math.min(POPUP_MAX_HEIGHT, Math.max(POPUP_MIN_HEIGHT, startHeight + delta));
        document.body.style.height = `${newHeight}px`;
      }

      function endDrag(): void {
        isDragging = false;
        grabber.classList.remove('dragging');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', onTouchEnd);
        saveHeight();
      }

      const onMouseMove = (e: MouseEvent) => applyDelta(e.clientY);
      const onMouseUp = () => endDrag();
      const onTouchMove = (e: TouchEvent) => { e.preventDefault(); applyDelta(e.touches[0].clientY); };
      const onTouchEnd = () => endDrag();

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.addEventListener('touchmove', onTouchMove, { passive: false });
      document.addEventListener('touchend', onTouchEnd);
    }

    grabber.addEventListener('mousedown', (e: MouseEvent) => { e.preventDefault(); startDrag(e.clientY); });
    grabber.addEventListener('touchstart', (e: TouchEvent) => { e.preventDefault(); startDrag(e.touches[0].clientY); }, { passive: false });

    window.addEventListener('blur', () => {
      if (isDragging) saveHeight();
    });

    grabber.addEventListener('dblclick', () => {
      document.body.style.height = '';
      browser.storage.local.remove(STORAGE_KEYS.POPUP_HEIGHT).catch(() => {});
    });
}
