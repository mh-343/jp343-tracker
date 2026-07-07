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
    #${CHIP_ID} .jp343-dc-vote {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
    }
    #${CHIP_ID} .jp343-dc-vote-btn {
      --vc: #bbb;
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 5px;
      color: var(--vc);
      font-family: inherit;
      font-size: 11px;
      line-height: 1.2;
      padding: 1px 6px;
      cursor: pointer;
    }
    #${CHIP_ID} .jp343-dc-vote-btn:hover:not(:disabled) {
      border-color: var(--vc);
    }
    #${CHIP_ID} .jp343-dc-vote-btn:disabled {
      opacity: 0.5;
      cursor: default;
    }
    #${CHIP_ID} .jp343-dc-vote-btn.jp343-dc-selected {
      background: var(--vc);
      border-color: var(--vc);
      color: #111;
      font-weight: 600;
    }
    #${CHIP_ID} .jp343-dc-easier { --vc: #4ade80; }
    #${CHIP_ID} .jp343-dc-spot { --vc: #60a5fa; }
    #${CHIP_ID} .jp343-dc-harder { --vc: #fb923c; }
    #${CHIP_ID} .jp343-dc-vmix { --vc: #9ca3af; }
    #${CHIP_ID} .jp343-dc-vmix.jp343-dc-selected {
      background: #f0b429;
      border-color: #f0b429;
    }
    #${CHIP_ID} .jp343-dc-vote-prompt {
      color: #999;
      font-size: 11px;
      margin-right: 2px;
    }
    #${CHIP_ID} .jp343-dc-vote-msg {
      color: #f0b429;
      font-size: 11px;
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

export interface ChipVoteContext {
  ownVote: { level: number | null; mixed: boolean } | null;
  onVote: (level: number | null, mixed: boolean) => Promise<{ ok: boolean; message?: string }>;
}

interface VoteOption {
  key: string;
  label: string;
  colorClass: string;
  title: string;
  mixed: boolean;
  delta: number;
}

const VOTE_OPTIONS: VoteOption[] = [
  { key: 'easier', label: 'Easier', colorClass: 'jp343-dc-easier', title: 'Easier than our estimate', mixed: false, delta: -1 },
  { key: 'spot', label: 'Spot on', colorClass: 'jp343-dc-spot', title: 'Our estimate is about right', mixed: false, delta: 0 },
  { key: 'harder', label: 'Harder', colorClass: 'jp343-dc-harder', title: 'Harder than our estimate', mixed: false, delta: 1 },
  { key: 'mixed', label: 'Mixed', colorClass: 'jp343-dc-vmix', title: 'Mixed difficulty', mixed: true, delta: 0 }
];

function clampLevel(value: number): number {
  return Math.max(1, Math.min(5, value));
}

function voteButton(doc: Document, label: string, colorClass: string, selected: boolean, title: string, onClick: () => void): HTMLButtonElement {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = selected
    ? `jp343-dc-vote-btn ${colorClass} jp343-dc-selected`
    : `jp343-dc-vote-btn ${colorClass}`;
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

function buildVoteArea(doc: Document, ctx: ChipVoteContext, anchorLevel: number): HTMLSpanElement {
  const area = doc.createElement('span');
  area.className = 'jp343-dc-vote';
  let currentVote = ctx.ownVote;
  let sending = false;

  function selectionKey(): string | null {
    if (!currentVote) return null;
    if (currentVote.mixed) return 'mixed';
    if (currentVote.level == null) return null;
    if (currentVote.level < anchorLevel) return 'easier';
    if (currentVote.level > anchorLevel) return 'harder';
    return 'spot';
  }

  function render(): void {
    area.textContent = '';
    area.appendChild(span(doc, 'jp343-dc-vote-prompt', 'This felt:'));
    const selected = selectionKey();
    const buttons: Array<{ el: HTMLButtonElement; locked: boolean }> = [];
    const msg = span(doc, 'jp343-dc-vote-msg', '');
    const cast = (level: number | null, mixed: boolean): void => {
      if (sending) return;
      sending = true;
      buttons.forEach(b => { b.el.disabled = true; });
      msg.textContent = '';
      void ctx.onVote(level, mixed).then(result => {
        sending = false;
        if (result.ok) {
          currentVote = { level, mixed };
          render();
        } else {
          buttons.forEach(b => { if (!b.locked) b.el.disabled = false; });
          msg.textContent = result.message || 'Vote failed, try again later';
        }
      });
    };
    for (const opt of VOTE_OPTIONS) {
      const locked = (opt.key === 'easier' && anchorLevel <= 1) || (opt.key === 'harder' && anchorLevel >= 5);
      const btn = voteButton(doc, opt.label, opt.colorClass, selected === opt.key, opt.title, () => {
        if (opt.mixed) cast(null, true);
        else cast(clampLevel(anchorLevel + opt.delta), false);
      });
      if (locked) btn.disabled = true;
      buttons.push({ el: btn, locked });
    }
    buttons.forEach(b => area.appendChild(b.el));
    area.appendChild(msg);
  }

  render();
  return area;
}

export function showDifficultyChip(seed: DifficultySeed, source: string, voteCtx?: ChipVoteContext): void {
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

  if (voteCtx) {
    chip.appendChild(span(doc, 'jp343-dc-sep', '|'));
    chip.appendChild(buildVoteArea(doc, voteCtx, clampLevel(seed.level)));
  }

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
