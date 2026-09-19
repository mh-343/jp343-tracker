import type { PendingEntry } from '../../types';
import type { SyncStatus } from '../../lib/background/sync-messages';
import { formatDuration, formatSessionDate } from '../../lib/format-utils';

interface SyncReply { success?: boolean; data?: SyncStatus; error?: string }

function issueText(entry: PendingEntry, status: SyncStatus): string {
  if (entry.syncState?.status === 'blocked') {
    switch (entry.syncState.errorCode) {
      case 'E102': return 'Cannot sync: invalid project.';
      case 'E103': return 'Cannot sync: invalid session details (minimum 1 minute).';
      case 'E104': return 'Cannot sync: this session exceeds 24 hours.';
      default: return 'Cannot sync this entry.';
    }
  }
  if (!status.signedIn || status.relogin || entry.syncState?.failureKind === 'auth') return 'Sign in to sync.';
  const next = Math.max(status.nextDispatchAt, entry.syncState?.nextAttemptAt ?? 0);
  return next > Date.now()
    ? `Waiting to retry in about ${Math.max(1, Math.ceil((next - Date.now()) / 60_000))} min.`
    : 'Waiting to retry automatically.';
}

export function createSyncIssues(root: HTMLElement, dayStartHour: () => number): { refresh: () => Promise<void> } {
  let status: SyncStatus | null = null;
  let expanded = false;
  let busy = false;
  let message = '';
  let signature = '';
  let fetching = false;

  function button(label: string, action: () => void, disabled = false): HTMLButtonElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = label;
    el.disabled = disabled || busy;
    el.addEventListener('click', action);
    return el;
  }

  async function perform(request: { type: string; entryIds?: string[]; entryId?: string }): Promise<void> {
    if (busy) return;
    busy = true;
    message = 'Working…';
    render();
    try {
      const response = await browser.runtime.sendMessage(request) as SyncReply;
      if (!response?.success) throw new Error(response?.error || 'Please try again.');
      message = request.type === 'RETRY_PENDING_SYNC'
        ? 'Retry requested. Any server wait still applies.' : 'Moved to Recently deleted in the dashboard.';
    } catch (error) {
      message = error instanceof Error ? error.message : 'Please try again.';
    } finally {
      busy = false;
      signature = '';
      await refresh();
      render();
    }
  }

  function render(): void {
    if (!status) return;
    root.hidden = status.entries.length === 0 && !message;
    root.replaceChildren();
    if (root.hidden) return;
    const title = document.createElement('strong');
    title.textContent = status.entries.length ? `${status.entries.length} session${status.entries.length === 1 ? ' needs' : 's need'} sync attention` : 'Sync issues cleared';
    const note = document.createElement('p');
    note.textContent = status.entries.length ? 'Your time is saved on this device.' : 'No sessions need attention.';
    root.append(title, note);
    const actions = document.createElement('div');
    actions.className = 'sync-issue-actions';
    if (status.entries.length) {
      const review = button(expanded ? 'Hide details' : 'Review', () => { expanded = !expanded; render(); });
      review.setAttribute('aria-expanded', String(expanded));
      review.setAttribute('aria-controls', 'syncIssueList');
      actions.append(review);
      if (!status.signedIn || status.relogin) {
        actions.append(button('Sign in', () => { void browser.runtime.sendMessage({ type: 'OPEN_DASHBOARD' }); }));
      } else if (status.entries.some(e => e.syncState?.status !== 'blocked')) {
        actions.append(button('Retry all', () => { void perform({ type: 'RETRY_PENDING_SYNC', entryIds: status!.entries.filter(e => e.syncState?.status !== 'blocked').map(e => e.id) }); }));
      }
    }
    if (message) {
      const info = document.createElement('p');
      info.className = 'sync-issue-feedback';
      info.setAttribute('role', 'status');
      info.textContent = message;
      root.append(info);
      if (!status.entries.length) actions.append(button('Dismiss', () => { message = ''; render(); }));
    }
    root.append(actions);
    if (!expanded) return;
    const list = document.createElement('div');
    list.id = 'syncIssueList';
    list.className = 'sync-issue-list';
    for (const entry of status.entries) {
      const row = document.createElement('div');
      row.className = 'sync-issue-row';
      row.dataset.entryId = entry.id;
      const name = document.createElement('strong');
      name.textContent = entry.project || 'Untitled session';
      const meta = document.createElement('p');
      meta.textContent = `${entry.platform} · ${formatSessionDate(entry.date, dayStartHour())} · ${formatDuration(entry.duration_min)}`;
      const reason = document.createElement('p');
      reason.textContent = issueText(entry, status);
      row.append(name, meta, reason);
      if (entry.syncState?.status === 'blocked') {
        if (entry.serverEntryId != null) {
          row.append(button('Review in dashboard', () => { void browser.runtime.sendMessage({ type: 'OPEN_DASHBOARD' }); }));
        } else {
          row.append(button('Remove local entry', () => { void perform({ type: 'REMOVE_BLOCKED_SYNC_ENTRY', entryId: entry.id }); }));
        }
      } else if (status.signedIn && !status.relogin) {
        row.append(button('Retry now', () => { void perform({ type: 'RETRY_PENDING_SYNC', entryIds: [entry.id] }); }));
      }
      list.append(row);
    }
    root.append(list);
  }

  async function refresh(): Promise<void> {
    if (fetching || busy) return;
    fetching = true;
    try {
      const reply = await browser.runtime.sendMessage({ type: 'GET_SYNC_STATUS' }) as SyncReply;
      if (!reply?.success || !reply.data) throw new Error(reply?.error || 'Could not load sync status.');
      const next = JSON.stringify(reply.data);
      if (next !== signature) {
        signature = next;
        status = reply.data;
        render();
      }
    } catch {
      if (status?.entries.length) { message = 'Could not refresh sync status. Please reopen the popup.'; render(); }
    } finally { fetching = false; }
  }

  return { refresh };
}
