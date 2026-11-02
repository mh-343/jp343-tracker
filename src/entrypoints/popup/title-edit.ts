import type { TrackingSession } from '../../types';

const DEBUG_MODE = import.meta.env.DEV;
const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};

export interface TitleEditOptions {
  elements: { sessionTitle: HTMLElement; sessionPlatform: HTMLElement; btnEditTitle: HTMLButtonElement };
  getCurrentSession: () => TrackingSession | null;
}

export function initTitleEdit(options: TitleEditOptions): void {
  const { elements, getCurrentSession } = options;
  let isEditingTitle = false;

  elements.btnEditTitle.addEventListener('click', () => {
    if (isEditingTitle || !getCurrentSession()) return;
    startTitleEdit();
  });

  function showTitleEditError(): void {
    const el = elements.sessionPlatform;
    const prev = el.textContent;
    el.textContent = 'Rename failed';
    setTimeout(() => {
      if (el.textContent === 'Rename failed') el.textContent = prev;
    }, 3000);
  }

  function startTitleEdit(): void {
    if (!getCurrentSession()) return;
    isEditingTitle = true;

    const titleRow = elements.sessionTitle.parentElement;
    if (!titleRow) return;

    const currentTitle = elements.sessionTitle.textContent || '';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'session-title-input';
    input.value = currentTitle;

    elements.sessionTitle.style.display = 'none';
    elements.btnEditTitle.style.display = 'none';

    titleRow.insertBefore(input, elements.sessionTitle);
    input.focus();
    input.select();

    let isSavingTitle = false;
    const saveEdit = async () => {
      if (isSavingTitle) return;
      const newTitle = input.value.trim();
      if (newTitle && newTitle !== currentTitle) {
        isSavingTitle = true;
        input.disabled = true;
        try {
          const res = await browser.runtime.sendMessage({
            type: 'UPDATE_SESSION_TITLE',
            title: newTitle
          });
          if (res?.success) {
            elements.sessionTitle.textContent = res.data?.title ?? newTitle;
            log('[JP343 Popup] Title updated:', newTitle);
          } else {
            elements.sessionTitle.textContent = currentTitle;
            showTitleEditError();
            log('[JP343 Popup] Title update rejected:', res?.error);
          }
        } catch (error) {
          showTitleEditError();
          log('[JP343 Popup] Failed to update title:', error);
        }
      }

      input.remove();
      elements.sessionTitle.style.display = '';
      elements.btnEditTitle.style.display = '';
      isEditingTitle = false;
    };

    input.addEventListener('blur', saveEdit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveEdit();
      }
      if (e.key === 'Escape') {
        input.value = currentTitle;
        saveEdit();
      }
    });
  }
}
