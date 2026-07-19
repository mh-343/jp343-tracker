import type { AnkiState } from '../../types';
import { STORAGE_KEYS } from '../../types';
import { getLocalDateString } from '../../lib/format-utils';
import { createToggleRow, getFreshSettings } from './settings-helpers';
import { armDeleteButton } from './delete-confirm';

function ankiTodayReviews(state: AnkiState, dayStartHour: number): number {
  const col = state.activeCollection ? state.collections[state.activeCollection] : undefined;
  if (!col) return 0;
  const today = getLocalDateString(new Date(), dayStartHour);
  return col.days[today]?.reviews ?? 0;
}

function formatAnkiStatus(state: AnkiState, dayStartHour: number): string {
  switch (state.status) {
    case 'connected':
      return `Connected · ${ankiTodayReviews(state, dayStartHour)} reviews today`;
    case 'unreachable':
      return 'Not connected. Open the Anki desktop app to sync.';
    case 'permission_needed':
      return 'In Anki, click Yes on the permission popup, then press Test.';
    case 'api_key_required':
      return 'Remove the apiKey in your AnkiConnect config to allow syncing.';
    case 'error':
      return 'Could not read from Anki. Make sure it is open, then press Test.';
    default:
      return 'Not connected yet.';
  }
}

async function saveDeckSelection(allDecks: string[], list: HTMLElement): Promise<void> {
  const checked: string[] = [];
  list.querySelectorAll('input[type="checkbox"]').forEach(node => {
    const cb = node as HTMLInputElement;
    if (cb.checked && cb.dataset.deck) checked.push(cb.dataset.deck);
  });
  const decks = (checked.length === 0 || checked.length === allDecks.length) ? [] : checked;
  await browser.runtime.sendMessage({ type: 'SET_ANKI_DECKS', decks });
}

async function renderDeckPicker(container: HTMLElement): Promise<void> {
  container.textContent = '';
  const res = await browser.runtime.sendMessage({ type: 'GET_ANKI_DECKS' });
  const data = res?.success ? res.data as { decks: string[]; selected: string[]; reachable: boolean } : null;
  if (!data || !data.reachable) {
    const hint = document.createElement('div');
    hint.className = 'settings-row-desc';
    hint.textContent = 'Open Anki to choose which decks count.';
    container.appendChild(hint);
    return;
  }
  if (data.decks.length === 0) return;

  const label = document.createElement('div');
  label.className = 'settings-row-label';
  label.textContent = 'Decks counted for jp343';
  container.appendChild(label);

  const desc = document.createElement('div');
  desc.className = 'settings-row-desc';
  desc.textContent = 'All decks count by default. Uncheck a deck (e.g. another language) to leave it out.';
  container.appendChild(desc);

  const all = data.selected.length === 0;
  const selectedSet = new Set(data.selected);
  const list = document.createElement('div');
  list.className = 'anki-deck-list';
  for (const deck of data.decks) {
    const rowEl = document.createElement('label');
    rowEl.className = 'anki-deck-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = all || selectedSet.has(deck);
    cb.dataset.deck = deck;
    cb.addEventListener('change', () => saveDeckSelection(data.decks, list));
    const name = document.createElement('span');
    name.textContent = deck;
    rowEl.appendChild(cb);
    rowEl.appendChild(name);
    list.appendChild(rowEl);
  }
  container.appendChild(list);
}

const ANKI_ORIGIN = 'http://127.0.0.1:8765/*';

// user-gesture only
function requestAnkiPermission(): Promise<boolean> {
  try {
    return browser.permissions.request({ origins: [ANKI_ORIGIN] });
  } catch {
    return Promise.resolve(false);
  }
}

async function hasAnkiPermission(): Promise<boolean> {
  try {
    return await browser.permissions.contains({ origins: [ANKI_ORIGIN] });
  } catch {
    return false;
  }
}

async function refreshAnki(statusEl: HTMLElement, toggle: HTMLElement | null, deckContainer: HTMLElement): Promise<void> {
  const res = await browser.storage.local.get(STORAGE_KEYS.ANKI);
  const state = res[STORAGE_KEYS.ANKI] as AnkiState | undefined;
  if (toggle) toggle.classList.toggle('enabled', !!state?.enabled);
  if (!state || !state.enabled) {
    statusEl.textContent = 'Off. Enable to read your Anki review time and stats.';
    deckContainer.textContent = '';
    return;
  }
  if (!(await hasAnkiPermission())) {
    statusEl.textContent = 'Allow access to your Anki app, then press Test connection.';
    deckContainer.textContent = '';
    return;
  }
  const settings = await getFreshSettings();
  statusEl.textContent = formatAnkiStatus(state, settings.dayStartHour || 0);
  void renderDeckPicker(deckContainer);
}

export function buildAnkiPanel(container: HTMLElement): void {
  const section = document.createElement('div');
  section.className = 'settings-section';

  const titleRow = document.createElement('div');
  titleRow.className = 'anki-title-row';
  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'Anki';
  const info = document.createElement('button');
  info.type = 'button';
  info.className = 'anki-info-btn';
  info.textContent = 'ⓘ';
  info.setAttribute('aria-label', 'How Anki tracking works');
  titleRow.appendChild(title);
  titleRow.appendChild(info);
  section.appendChild(titleRow);

  const help = document.createElement('div');
  help.className = 'anki-help';
  help.textContent = 'jp343 reads your study time and reviews straight from the Anki desktop app through the free AnkiConnect add-on. In Anki open Tools → Add-ons → Get Add-ons, paste the code 2055492159, then restart Anki and switch this on. The first time, Anki asks you to allow access, then click Yes. Desktop only; phone apps (AnkiDroid, AnkiMobile) cannot be read.';
  info.addEventListener('click', () => help.classList.toggle('open'));
  section.appendChild(help);

  const status = document.createElement('div');
  status.className = 'settings-row-desc';
  status.textContent = 'Checking…';

  const deckContainer = document.createElement('div');
  deckContainer.className = 'anki-deck-picker';

  let toggle: HTMLElement | null = null;
  const row = createToggleRow(
    'Track Anki review time',
    'Count your Anki study time, reviews and retention.',
    false,
    async (val) => {
      if (val && !(await requestAnkiPermission())) {
        if (toggle) toggle.classList.remove('enabled');
        status.textContent = 'Allow access to your Anki app to turn this on.';
        return;
      }
      status.textContent = val ? 'Connecting…' : 'Off.';
      await browser.runtime.sendMessage({ type: 'SET_ANKI_ENABLED', enabled: val });
      await refreshAnki(status, toggle, deckContainer);
    }
  );
  toggle = row.querySelector('.settings-toggle') as HTMLElement | null;
  section.appendChild(row);
  section.appendChild(status);

  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'export-btn';
  testBtn.textContent = 'Test connection';
  testBtn.addEventListener('click', async () => {
    if (!(await requestAnkiPermission())) {
      status.textContent = 'Allow access to your Anki app to sync.';
      return;
    }
    testBtn.disabled = true;
    status.textContent = 'Connecting…';
    await browser.runtime.sendMessage({ type: 'ANKI_SYNC_NOW' });
    await refreshAnki(status, toggle, deckContainer);
    testBtn.disabled = false;
  });
  section.appendChild(testBtn);
  section.appendChild(deckContainer);

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'anki-reset-btn';
  resetBtn.textContent = 'Reset Anki data';
  armDeleteButton(resetBtn, async () => {
    resetBtn.disabled = true;
    resetBtn.textContent = 'Resetting…';
    await browser.runtime.sendMessage({ type: 'ANKI_RESET' });
    await refreshAnki(status, toggle, deckContainer);
    resetBtn.disabled = false;
    resetBtn.textContent = 'Reset Anki data';
  }, {
    idleLabel: 'Reset Anki data',
    armedLabel: 'Click again to delete all Anki stats',
    idleTitle: '',
    armedTitle: ''
  });
  section.appendChild(resetBtn);

  const resetDesc = document.createElement('div');
  resetDesc.className = 'settings-row-desc';
  resetDesc.textContent = 'Deletes your Anki stats here and on jp343.com. They rebuild from Anki on the next sync.';
  section.appendChild(resetDesc);

  container.appendChild(section);
  void refreshAnki(status, toggle, deckContainer);
}
