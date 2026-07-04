import type { DifficultySeed } from './difficulty-seeds';

const CHIP_ID = 'jp343-difficulty-chip';
const STYLE_ID = 'jp343-difficulty-chip-styles';

const MOUNT_SELECTORS = [
  '#above-the-fold #title',
  'ytd-watch-metadata #title',
  'ytd-watch-metadata',
];

function injectStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${CHIP_ID} {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin: 6px 0 2px 0;
      padding: 4px 10px;
      border-radius: 8px;
      background: rgba(12, 12, 20, 0.85);
      border: 1px solid rgba(255, 0, 128, 0.25);
      color: #fff;
      font-family: 'Roboto', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 12px;
      line-height: 1.4;
      user-select: none;
    }
    #${CHIP_ID} .jp343-dc-level {
      font-weight: 600;
      color: #ff4fa3;
    }
    #${CHIP_ID} .jp343-dc-sep {
      color: #666;
    }
    #${CHIP_ID} .jp343-dc-hint {
      color: #bbb;
    }
    #${CHIP_ID} .jp343-dc-mixed {
      color: #f0b429;
    }
    #${CHIP_ID} .jp343-dc-tag {
      color: #555;
      font-size: 10px;
      letter-spacing: 0.4px;
      text-transform: uppercase;
    }
  `;
  doc.head.appendChild(style);
}

function findMountPoint(doc: Document): Element | null {
  for (const selector of MOUNT_SELECTORS) {
    const el = doc.querySelector(selector);
    if (el) return el;
  }
  return null;
}

function span(doc: Document, className: string, text: string): HTMLSpanElement {
  const el = doc.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

export function showDifficultyChip(seed: DifficultySeed, source: string): void {
  const doc = document;
  const mount = findMountPoint(doc);
  if (!mount) return;

  injectStyles(doc);
  hideDifficultyChip();

  const chip = doc.createElement('div');
  chip.id = CHIP_ID;

  if (seed.mixed) {
    const label = seed.jlptHint ? `Mixed ${seed.jlptHint}` : `Mixed difficulty (around level ${seed.level})`;
    chip.appendChild(span(doc, 'jp343-dc-mixed', label));
  } else {
    chip.appendChild(span(doc, 'jp343-dc-level', seed.jlptHint || `Level ${seed.level} of 5`));
  }

  chip.appendChild(span(doc, 'jp343-dc-sep', '|'));
  chip.title = `jp343 difficulty (beta), source: ${source}`;
  chip.appendChild(span(doc, 'jp343-dc-tag', 'jp343 beta'));

  if (mount.tagName.toLowerCase() === 'ytd-watch-metadata') {
    mount.prepend(chip);
  } else {
    mount.appendChild(chip);
  }
}

export function hideDifficultyChip(): void {
  document.getElementById(CHIP_ID)?.remove();
}

export function isDifficultyChipMounted(): boolean {
  return document.getElementById(CHIP_ID) !== null;
}
