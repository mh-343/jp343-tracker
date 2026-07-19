interface DeleteConfirmOptions {
  idleLabel?: string;
  idleTitle?: string;
  armedLabel?: string;
  armedTitle?: string;
}

export function armDeleteButton(
  btn: HTMLButtonElement,
  onConfirm: () => Promise<void>,
  opts: DeleteConfirmOptions = {}
): void {
  const idleLabel = opts.idleLabel ?? '×';
  const idleTitle = opts.idleTitle ?? 'Delete';
  const armedLabel = opts.armedLabel ?? 'Sure?';
  const armedTitle = opts.armedTitle ?? 'Click again to delete';
  let armed = false;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = (): void => {
    armed = false;
    btn.classList.remove('armed');
    btn.textContent = idleLabel;
    btn.title = idleTitle;
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (busy) return;
    if (!armed) {
      armed = true;
      btn.classList.add('armed');
      btn.textContent = armedLabel;
      btn.title = armedTitle;
      timer = setTimeout(disarm, 4000);
      return;
    }
    if (timer) clearTimeout(timer);
    disarm();
    busy = true;
    void onConfirm().finally(() => { busy = false; });
  });
}
