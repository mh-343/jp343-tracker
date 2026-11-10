const FULL_CLASS = 'sessions-full';
const NORMAL_MAX_GROUPS = 8;
const FULL_MAX_GROUPS = 30;

export interface SessionsViewDeps {
  expandBtn: HTMLButtonElement;
  backBtn: HTMLButtonElement;
  listEl: HTMLElement;
  onChange: () => void;
}

export interface SessionsView {
  isFull: () => boolean;
  maxGroups: () => number;
  exit: () => void;
}

export function createSessionsView(deps: SessionsViewDeps): SessionsView {
  function isFull(): boolean {
    return document.body.classList.contains(FULL_CLASS);
  }

  function setFull(full: boolean): void {
    if (full === isFull()) return;
    document.body.classList.toggle(FULL_CLASS, full);
    deps.expandBtn.setAttribute('aria-expanded', String(full));
    deps.listEl.scrollTop = 0;
    deps.onChange();
    (full ? deps.backBtn : deps.expandBtn).focus();
  }

  deps.expandBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setFull(true);
  });
  deps.backBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setFull(false);
  });

  return {
    isFull,
    maxGroups: () => (isFull() ? FULL_MAX_GROUPS : NORMAL_MAX_GROUPS),
    exit: () => setFull(false)
  };
}
