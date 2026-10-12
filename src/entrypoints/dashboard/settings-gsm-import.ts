import { formatStatDuration } from '../../lib/format-utils';
import type { GsmImportCounts, GsmImportError, GsmImportGameSummary, GsmImportPreview } from '../../lib/gsm/import';

const ERROR_TEXT: Record<GsmImportError, string> = {
  not_enabled: 'Switch syncing on first. Everything before that moment can then be imported.',
  not_ready: 'GameSentenceMiner is still connecting. Try again in a minute.',
  unreachable: 'Start GameSentenceMiner on this computer, then try again.',
  unsupported: 'This GameSentenceMiner version is not supported yet.',
  too_many_games: 'GameSentenceMiner has more than 2000 games. Importing is not possible.',
};

const UPLOAD_TEXT: Record<Exclude<GsmImportCounts['uploadStatus'], null>, string> = {
  ok: 'Uploading to your account…',
  signed_out: 'Log in on jp343.com to add them to your account.',
  server_unavailable: 'jp343.com could not be reached. Upload retries automatically.',
  other_account: 'They belong to another jp343.com account.',
};

interface Response<T> { success: boolean; data?: T; error?: string; }

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function errorText(error: string | undefined): string {
  return error && error in ERROR_TEXT ? ERROR_TEXT[error as GsmImportError] : 'Could not read GSM history. Try again.';
}

function countsText(counts: GsmImportCounts): string {
  if (!counts.sessions && !counts.deleted && !counts.serverDeleted && !counts.deferredGames) return '';
  const parts = [`Imported: ${plural(counts.sessions, 'session', 'sessions')} (${formatStatDuration(counts.seconds / 60)}).`];
  if (counts.pending > 0) {
    const upload = counts.uploadStatus ? ` ${UPLOAD_TEXT[counts.uploadStatus]}` : '';
    parts.push(`${plural(counts.pending, 'session waits', 'sessions wait')} for upload.${upload}`);
  }
  if (counts.uploaded > 0) parts.push(`${counts.uploaded} in your account.`);
  if (counts.failed > 0) parts.push(`${plural(counts.failed, 'session', 'sessions')} could not be uploaded.`);
  if (counts.rejected > 0) parts.push(`${plural(counts.rejected, 'session was', 'sessions were')} not accepted by jp343.com.`);
  if (counts.serverDeleted > 0) {
    parts.push(`${plural(counts.serverDeleted, 'session was', 'sessions were')} skipped: jp343.com already has that time or you deleted it there.`);
  }
  if (counts.notJapanese > 0) {
    parts.push(`${plural(counts.notJapanese, 'session', 'sessions')} not counted on the leaderboard (not Japanese). The time still counts in your account.`);
  }
  if (counts.deferredGames > 0) parts.push('A session that is still running is added automatically once it ends.');
  return parts.join(' ');
}

function gameMeta(game: GsmImportGameSummary): string {
  const range = game.firstDay === game.lastDay ? game.firstDay : `${game.firstDay} to ${game.lastDay}`;
  const parts = [`${plural(game.sessions, 'session', 'sessions')}, ${formatStatDuration(game.seconds / 60)}, ${range}`];
  parts.push(game.fresh > 0 ? `${game.fresh} new (${formatStatDuration(game.freshSeconds / 60)})` : 'nothing new');
  if (game.existing > 0) parts.push(`${game.existing} already counted`);
  if (game.overlapping > 0) parts.push(`${game.overlapping} overlap with counted time`);
  if (game.later > 0) parts.push(`${game.later} still running`);
  if (game.notJapanese > 0) parts.push(`${game.notJapanese} not Japanese`);
  if (game.archived) parts.push('archived in GSM');
  return parts.join(' · ');
}

function renderGameRow(game: GsmImportGameSummary): HTMLLabelElement {
  const row = document.createElement('label');
  row.className = 'gsm-import-row';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.dataset.game = game.uuid;
  const selectable = game.fresh > 0 || game.later > 0;
  box.checked = selectable && !game.archived;
  box.disabled = !selectable;
  if (!selectable) row.classList.add('disabled');
  const text = document.createElement('span');
  const name = document.createElement('span');
  name.className = 'gsm-import-name';
  name.textContent = game.title || game.uuid;
  const meta = document.createElement('span');
  meta.className = 'gsm-import-meta';
  meta.textContent = gameMeta(game);
  text.appendChild(name);
  text.appendChild(meta);
  row.appendChild(box);
  row.appendChild(text);
  return row;
}

export function buildGsmImportPanel(container: HTMLElement): void {
  const block = document.createElement('div');
  block.className = 'gsm-import';
  const label = document.createElement('div');
  label.className = 'settings-row-label';
  label.textContent = 'Older GSM history';
  const desc = document.createElement('div');
  desc.className = 'settings-row-desc';
  desc.textContent = 'Import reading time from before you switched syncing on. Imported sessions are saved once and later syncs never change them. Only import games you did not already log by hand on jp343.com, or the time counts twice.';
  const list = document.createElement('div');
  list.className = 'gsm-import-list';
  const status = document.createElement('div');
  status.className = 'settings-row-desc gsm-import-status';
  status.setAttribute('aria-live', 'polite');
  const counts = document.createElement('div');
  counts.className = 'settings-row-desc gsm-import-counts';
  const actions = document.createElement('div');
  actions.className = 'gsm-import-actions';
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'export-btn';
  check.textContent = 'Check history';
  const start = document.createElement('button');
  start.type = 'button';
  start.className = 'export-btn';
  start.textContent = 'Import';
  start.hidden = true;
  actions.appendChild(check);
  actions.appendChild(start);
  for (const node of [label, desc, list, actions, status, counts]) block.appendChild(node);
  container.appendChild(block);

  let busy = false;

  function selectedGames(): string[] {
    return [...list.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .filter(box => box.checked && !box.disabled && box.dataset.game)
      .map(box => box.dataset.game as string);
  }

  function updateStart(): void {
    start.disabled = busy || selectedGames().length === 0;
  }

  function renderPreview(preview: GsmImportPreview): void {
    list.textContent = '';
    if (!preview.games.length) {
      status.textContent = 'No GSM history from before you switched syncing on.';
      start.hidden = true;
      return;
    }
    for (const game of preview.games) list.appendChild(renderGameRow(game));
    const fresh = preview.games.reduce((sum, game) => sum + game.fresh, 0);
    status.textContent = fresh > 0
      ? 'Choose the games to import. Archived games are not selected by default.'
      : 'Everything from before you switched syncing on is already counted.';
    start.hidden = fresh === 0 && !preview.games.some(game => game.later > 0);
    updateStart();
  }

  async function refreshCounts(): Promise<void> {
    const response = await browser.runtime.sendMessage({ type: 'GET_GSM_IMPORT_STATUS' }) as Response<GsmImportCounts>;
    if (response.success && response.data) counts.textContent = countsText(response.data);
  }

  async function run(action: () => Promise<void>, loading: string): Promise<void> {
    busy = true;
    check.disabled = true;
    start.disabled = true;
    status.textContent = loading;
    try {
      await action();
    } catch {
      status.textContent = 'Could not reach the extension. Reload this page and try again.';
    } finally {
      busy = false;
      check.disabled = false;
      updateStart();
    }
  }

  list.addEventListener('change', updateStart);
  check.addEventListener('click', () => {
    void run(async () => {
      const response = await browser.runtime.sendMessage({ type: 'GSM_IMPORT_PREVIEW' }) as Response<GsmImportPreview>;
      if (!response.success || !response.data) {
        list.textContent = '';
        start.hidden = true;
        status.textContent = errorText(response.error);
        return;
      }
      renderPreview(response.data);
    }, 'Reading your GSM history. This can take a minute…');
  });
  start.addEventListener('click', () => {
    const games = selectedGames();
    if (!games.length) return;
    void run(async () => {
      const response = await browser.runtime.sendMessage({ type: 'GSM_IMPORT_START', games }) as Response<GsmImportCounts>;
      if (!response.success || !response.data) {
        status.textContent = errorText(response.error);
        return;
      }
      list.textContent = '';
      start.hidden = true;
      status.textContent = 'Import done. The time counts right away in this browser.';
      counts.textContent = countsText(response.data);
    }, 'Importing…');
  });

  void refreshCounts().catch(() => {});
  const timer = setInterval(() => {
    if (!block.isConnected) { clearInterval(timer); return; }
    if (busy || block.offsetParent === null || document.visibilityState !== 'visible') return;
    void refreshCounts().catch(() => {});
  }, 5000);
  window.addEventListener('pagehide', () => clearInterval(timer));
}
