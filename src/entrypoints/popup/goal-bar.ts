import { formatDuration } from '../../lib/format-utils';
import type { ActivityGoalRow } from '../../lib/activity-goals';
import { appendActivityGoalLines } from './activity-goals-tooltip';

function createGoalTooltipText<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className: string,
  text: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  return element;
}

function createGoalTooltipChip(text: string, isLevel = false): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.className = `goal-tooltip-chip${isLevel ? ' is-level' : ''}`;
  chip.textContent = text;
  return chip;
}

export interface GoalBarOptions {
  getGoalMinutes: () => number;
  getStretchEnabled: () => boolean;
}

export function createGoalBar(options: GoalBarOptions): { render: (todayMinutes: number, activityRows?: ActivityGoalRow[]) => void } {
  const goalWrap = document.getElementById('goalMicroWrap');
  if (goalWrap) {
    goalWrap.addEventListener('click', (e) => {
      e.stopPropagation();
      goalWrap.classList.toggle('tooltip-open');
    });
    document.addEventListener('click', () => {
      goalWrap.classList.remove('tooltip-open');
    });
  }

  function render(todayMinutes: number, activityRows: ActivityGoalRow[] = []): void {
    const fill = document.getElementById('goalMicroFill') as HTMLDivElement | null;
    if (!fill) return;
    const bar = fill.parentElement;
    const wrap = document.getElementById('goalMicroWrap') as HTMLDivElement | null;
    const tooltip = document.getElementById('goalTooltip') as HTMLDivElement | null;
    const safeGoal = options.getGoalMinutes() || 60;
    const progress = Math.round((todayMinutes / safeGoal) * 100);
    const isOverflow = progress >= 100;
    const timeStr = formatDuration(todayMinutes);
    const goalStr = formatDuration(safeGoal);

    fill.classList.remove('overflow', 'stretch');
    if (bar) bar.classList.remove('overflow');
    fill.style.background = '';
    fill.style.removeProperty('--goal-cutoff');
    if (wrap) {
      delete wrap.dataset.level;
      wrap.dataset.goalState = isOverflow ? (options.getStretchEnabled() ? 'stretch' : 'complete') : 'progress';
    }

    let currentLevel = 0;
    let detailText = '';

    if (isOverflow && options.getStretchEnabled()) {
      const ratio = todayMinutes / safeGoal;
      const thresholds = [1.0, 1.5, 2.0, 2.5, 3.0];
      currentLevel = 1;
      for (let i = thresholds.length - 1; i >= 0; i--) {
        if (ratio >= thresholds[i]) { currentLevel = i + 1; break; }
      }

      if (wrap) wrap.dataset.level = String(currentLevel);

      const levelIdx = currentLevel - 1;
      const start = thresholds[levelIdx];
      const end = levelIdx + 1 < thresholds.length ? thresholds[levelIdx + 1] : null;

      if (end !== null) {
        const intra = Math.round(((ratio - start) / (end - start)) * 100);
        fill.style.width = `${Math.min(intra, 100)}%`;
        fill.classList.add('stretch');
      } else if (ratio > 3.0) {
        fill.style.width = '100%';
        fill.classList.add('stretch', 'overflow');
        if (bar) bar.classList.add('overflow');
        const overProgress = Math.round(((ratio - 3.0) / 0.5) * 100);
        const cutoff = Math.round((100 / overProgress) * 100);
        fill.style.setProperty('--goal-cutoff', `${cutoff}%`);
        if (wrap) wrap.dataset.goalState = 'overflow';
      } else {
        fill.style.width = '100%';
        fill.classList.add('stretch');
      }
    } else if (isOverflow) {
      fill.style.width = '100%';
      fill.classList.add('overflow');
      if (bar) bar.classList.add('overflow');
      const cutoff = (100 / progress) * 100;
      fill.style.background = `linear-gradient(90deg, var(--accent) ${cutoff}%, var(--gradient-secondary) ${cutoff}%)`;
      fill.style.setProperty('--goal-cutoff', `${cutoff}%`);
    } else {
      fill.style.width = `${progress}%`;
    }

    if (!tooltip) return;

    const header = document.createElement('div');
    header.className = 'goal-tooltip-header';
    header.append(
      createGoalTooltipText('span', 'goal-tooltip-kicker', 'Today'),
      createGoalTooltipText('strong', 'goal-tooltip-value', timeStr)
    );

    const metrics = document.createElement('div');
    metrics.className = 'goal-tooltip-metrics';
    metrics.appendChild(createGoalTooltipChip(`${progress}%`));

    if (currentLevel > 0) {
      metrics.appendChild(createGoalTooltipChip(`Stretch ${currentLevel}/5`, true));
    }

    metrics.appendChild(createGoalTooltipChip(`Goal: ${goalStr}`));

    if (todayMinutes < safeGoal) {
      detailText = `${formatDuration(safeGoal - todayMinutes)} left to reach your goal`;
    } else if (currentLevel > 0) {
      if (currentLevel >= 5) {
        detailText = `${formatDuration(todayMinutes - safeGoal * 3)} past the final stretch`;
      } else {
        const nextThreshold = [1.5, 2.0, 2.5, 3.0][currentLevel - 1];
        const nextTime = safeGoal * nextThreshold;
        detailText = `${formatDuration(nextTime - todayMinutes)} until stretch ${currentLevel + 1}/5`;
      }
    } else {
      detailText = `${formatDuration(todayMinutes - safeGoal)} past your goal`;
    }

    const card = document.createElement('div');
    card.className = 'goal-tooltip-card';
    card.append(
      header,
      metrics,
      createGoalTooltipText('div', 'goal-tooltip-note', detailText)
    );
    appendActivityGoalLines(card, activityRows);

    tooltip.replaceChildren(card);

    if (wrap) {
      wrap.setAttribute(
        'aria-label',
        `Daily goal progress. Today ${timeStr}. ${progress}% of goal. ${detailText}.`
      );
    }
  }

  return { render };
}
