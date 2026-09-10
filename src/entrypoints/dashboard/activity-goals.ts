import type { ExtensionStats, ExtensionSettings } from '../../types';
import { DEFAULT_STATS, EMPTY_DAILY_GOALS, STORAGE_KEYS } from '../../types';
import type { ActivityGoalRow } from '../../lib/activity-goals';
import { computeActivityGoalRows, ACTIVITY_GOAL_COLORS } from '../../lib/activity-goals';
import { formatGoalMinutes, getLocalDateString } from '../../lib/format-utils';
import { getDayStartHour, isAttentionDisplayEnabled } from './stats';

function openActivityGoalSettings(): void {
  document.getElementById('tabBtnSettings')?.click();
}

export function setupActivityGoals(): void {
  const container = document.getElementById('activityGoals');
  // isolate from goal-editor toggle
  container?.addEventListener('click', (e) => e.stopPropagation());
}

export async function refreshActivityGoals(): Promise<void> {
  const result = await browser.storage.local.get([STORAGE_KEYS.STATS, STORAGE_KEYS.SETTINGS]);
  const stats = (result[STORAGE_KEYS.STATS] as ExtensionStats | undefined) ?? DEFAULT_STATS;
  const settings = result[STORAGE_KEYS.SETTINGS] as ExtensionSettings | undefined;
  const todayKey = getLocalDateString(new Date(), getDayStartHour());

  const rows = computeActivityGoalRows(
    settings?.dailyGoals ?? EMPTY_DAILY_GOALS,
    stats.dailyMinutesByActivity?.[todayKey],
    stats.dailyActiveMinutes?.[todayKey] ?? 0,
    isAttentionDisplayEnabled()
  );
  renderActivityGoals(rows);
}

function createCta(label: string, className: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openActivityGoalSettings();
  });
  return btn;
}

export function renderActivityGoals(rows: ActivityGoalRow[]): void {
  const container = document.getElementById('activityGoals');
  if (!container) return;
  container.replaceChildren();

  if (rows.length === 0) {
    container.appendChild(createCta('Set activity goals', 'activity-goals-cta'));
    return;
  }

  for (const row of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'activity-goal-row';
    rowEl.dataset.key = row.key;
    const color = ACTIVITY_GOAL_COLORS[row.key];
    if (color) rowEl.style.setProperty('--activity-color', color);

    const dot = document.createElement('span');
    dot.className = 'activity-goal-dot';
    rowEl.appendChild(dot);

    const label = document.createElement('span');
    label.className = 'activity-goal-label';
    label.textContent = row.label;
    rowEl.appendChild(label);

    const stats = document.createElement('span');
    stats.className = 'activity-goal-stats';
    stats.textContent = `${formatGoalMinutes(row.doneMinutes)} / ${formatGoalMinutes(row.goalMinutes)}`;
    rowEl.appendChild(stats);

    const track = document.createElement('div');
    track.className = 'activity-goal-track';
    const fill = document.createElement('div');
    fill.className = 'activity-goal-fill';
    fill.style.width = `${row.percent}%`;
    track.appendChild(fill);
    rowEl.appendChild(track);

    if (row.reached) {
      rowEl.classList.add('is-reached');
      const reached = document.createElement('span');
      reached.className = 'activity-goal-reached';
      reached.textContent = 'Reached';
      rowEl.appendChild(reached);
    }

    container.appendChild(rowEl);
  }

  container.appendChild(createCta('Edit activity goals', 'activity-goals-edit'));
}
