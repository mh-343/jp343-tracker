import type { ActivityGoalRow } from '../../lib/activity-goals';
import { formatGoalMinutes } from '../../lib/format-utils';
import { ACTIVITY_GOAL_COLORS } from '../../lib/activity-goals';

export function appendActivityGoalLines(card: HTMLElement, rows: ActivityGoalRow[]): void {
  if (rows.length === 0) return;

  const list = document.createElement('div');
  list.className = 'goal-tooltip-goals';

  for (const row of rows) {
    const line = document.createElement('div');
    line.className = 'goal-tooltip-goal';
    const color = ACTIVITY_GOAL_COLORS[row.key];
    if (color) line.style.setProperty('--activity-color', color);

    const left = document.createElement('span');
    left.className = 'goal-tooltip-left';
    const dot = document.createElement('span');
    dot.className = 'goal-tooltip-dot';
    const label = document.createElement('span');
    label.textContent = row.label;
    left.append(dot, label);

    const stats = document.createElement('span');
    stats.textContent = `${formatGoalMinutes(row.doneMinutes)} / ${formatGoalMinutes(row.goalMinutes)}`;

    line.append(left, stats);

    if (row.reached) {
      const reached = document.createElement('span');
      reached.className = 'goal-tooltip-reached';
      reached.textContent = 'Reached';
      line.append(reached);
    }

    list.appendChild(line);
  }

  card.appendChild(list);
}
