import { STORAGE_KEYS } from '../../types';

export interface CollapsibleOptions {
  isLocked?: () => boolean;
  onChange?: (collapsed: boolean) => void;
}

export function initCollapsible(
  headerId: string,
  bodyId: string,
  arrowId: string,
  cardId: string,
  options: CollapsibleOptions = {}
): void {
  const header = document.getElementById(headerId);
  const body = document.getElementById(bodyId);
  const arrow = document.getElementById(arrowId);
  if (!header || !body || !arrow) return;
  let collapsed = false;
  browser.storage.local.get(STORAGE_KEYS.COLLAPSED_CARDS).then(result => {
    const ids: string[] = result[STORAGE_KEYS.COLLAPSED_CARDS] || [];
    if (ids.includes(cardId)) {
      collapsed = true;
      body.style.display = 'none';
      arrow.style.transform = 'rotate(-90deg)';
      options.onChange?.(true);
    }
  });
  header.addEventListener('click', () => {
    if (options.isLocked?.()) return;
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : '';
    arrow.style.transform = collapsed ? 'rotate(-90deg)' : '';
    options.onChange?.(collapsed);
    browser.storage.local.get(STORAGE_KEYS.COLLAPSED_CARDS).then(result => {
      const current: string[] = result[STORAGE_KEYS.COLLAPSED_CARDS] || [];
      const updated = collapsed
        ? [...current.filter(id => id !== cardId), cardId]
        : current.filter(id => id !== cardId);
      browser.storage.local.set({ [STORAGE_KEYS.COLLAPSED_CARDS]: updated });
    });
  });
}
