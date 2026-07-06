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
    #${CHIP_ID} .jp343-dc-rate {
      color: #888;
      cursor: pointer;
      text-decoration: underline dotted;
    }
    #${CHIP_ID} .jp343-dc-rate:hover {
      color: #ff4fa3;
    }
    #${CHIP_ID} .jp343-dc-vote-btn {
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.25);
      border-radius: 5px;
      color: #ddd;
      font-family: inherit;
      font-size: 11px;
      line-height: 1.2;
      padding: 1px 6px;
      cursor: pointer;
    }
    #${CHIP_ID} .jp343-dc-vote-btn:hover:not(:disabled) {
      border-color: #ff4fa3;
      color: #ff4fa3;
    }
    #${CHIP_ID} .jp343-dc-vote-btn:disabled {
      opacity: 0.5;
      cursor: default;
    }
    #${CHIP_ID} .jp343-dc-vote-btn.jp343-dc-selected {
      border-color: #ff4fa3;
      color: #ff4fa3;
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

const VOTE_LEVELS: Array<{ level: number; label: string }> = [
  { level: 1, label: 'N5' },
  { level: 2, label: 'N4' },
  { level: 3, label: 'N3' },
  { level: 4, label: 'N2' },
  { level: 5, label: 'N1' }
];

function voteLabel(vote: { level: number | null; mixed: boolean }): string {
  if (vote.mixed) return 'Mixed';
  const entry = VOTE_LEVELS.find(v => v.level === vote.level);
  return entry ? entry.label : `Level ${vote.level}`;
}

function voteButton(doc: Document, label: string, selected: boolean, onClick: () => void): HTMLButtonElement {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = selected ? 'jp343-dc-vote-btn jp343-dc-selected' : 'jp343-dc-vote-btn';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function buildVoteArea(doc: Document, ctx: ChipVoteContext): HTMLSpanElement {
  const area = doc.createElement('span');
  area.className = 'jp343-dc-vote';
  let currentVote = ctx.ownVote;

  function renderCollapsed(): void {
    area.textContent = '';
    const trigger = span(doc, 'jp343-dc-rate', currentVote ? `your vote: ${voteLabel(currentVote)}` : 'rate');
    trigger.title = 'Rate how hard this channel feels to you';
    trigger.addEventListener('click', renderExpanded);
    area.appendChild(trigger);
  }

  function renderExpanded(): void {
    area.textContent = '';
    const buttons: HTMLButtonElement[] = [];
    const msg = span(doc, 'jp343-dc-vote-msg', '');
    const cast = (level: number | null, mixed: boolean): void => {
      buttons.forEach(b => { b.disabled = true; });
      msg.textContent = '';
      void ctx.onVote(level, mixed).then(result => {
        if (result.ok) {
          currentVote = { level, mixed };
          renderCollapsed();
        } else {
          buttons.forEach(b => { b.disabled = false; });
          msg.textContent = result.message || 'Vote failed, try again later';
        }
      });
    };
    for (const v of VOTE_LEVELS) {
      const selected = !!currentVote && !currentVote.mixed && currentVote.level === v.level;
      buttons.push(voteButton(doc, v.label, selected, () => cast(v.level, false)));
    }
    buttons.push(voteButton(doc, 'Mixed', currentVote?.mixed ?? false, () => cast(null, true)));
    buttons.forEach(b => area.appendChild(b));
    area.appendChild(msg);
  }

  renderCollapsed();
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
    chip.appendChild(buildVoteArea(doc, voteCtx));
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
