import type { ActivityType, DailyGoals, ExtensionSettings } from '../../types';
import { DAILY_GOAL_MAX_MINUTES, DAILY_GOAL_MIN_MINUTES, EMPTY_DAILY_GOALS } from '../../types';
import type { ActivityGoalKey } from '../../lib/activity-goals';
import { ACTIVITY_GOAL_LABELS, ACTIVITY_GOAL_ORDER, validateGoalMinutes } from '../../lib/activity-goals';
import { formatGoalMinutes } from '../../lib/format-utils';
import { showStatus, updateSettings } from './settings-helpers';
import { refreshActivityGoals } from './activity-goals';

interface DraftRow {
  key: ActivityGoalKey | '';
  minutes: string;
  useHours: boolean;
}

function buildInitialDraft(goals: DailyGoals, attentionAllowed: boolean): DraftRow[] {
  const rows: DraftRow[] = [];
  for (const type of ACTIVITY_GOAL_ORDER) {
    const minutes = goals.byActivity[type];
    if (minutes !== undefined) rows.push({ key: type, minutes: String(minutes), useHours: false });
  }
  if (attentionAllowed && goals.activeMinutes !== null && goals.activeMinutes !== undefined) {
    rows.push({ key: 'active', minutes: String(goals.activeMinutes), useHours: false });
  }
  return rows;
}

function previewText(value: string): string {
  const num = Number(value);
  return value !== '' && Number.isFinite(num) ? formatGoalMinutes(num) : '';
}

function hoursText(minutes: string): string {
  const num = Number(minutes);
  if (minutes === '' || !Number.isFinite(num)) return '';
  return String(Math.round((num / 60) * 100) / 100);
}

function applyUnit(input: HTMLInputElement, row: DraftRow): void {
  input.min = row.useHours ? '0' : String(DAILY_GOAL_MIN_MINUTES);
  input.max = row.useHours ? '24' : String(DAILY_GOAL_MAX_MINUTES);
  input.step = row.useHours ? 'any' : '1';
  input.value = row.useHours ? hoursText(row.minutes) : row.minutes;
}

export function buildActivityGoalsSection(container: HTMLElement, settings: ExtensionSettings): void {
  const attentionAllowed = settings.showAttentionUi !== false;
  const goals = settings.dailyGoals ?? EMPTY_DAILY_GOALS;
  const existingActiveMinutes = goals.activeMinutes;
  const draft: DraftRow[] = buildInitialDraft(goals, attentionAllowed);
  const availableKeys: ActivityGoalKey[] = attentionAllowed
    ? [...ACTIVITY_GOAL_ORDER, 'active']
    : [...ACTIVITY_GOAL_ORDER];

  const block = document.createElement('div');
  block.className = 'settings-goals-block';

  const title = document.createElement('div');
  title.className = 'settings-row-label';
  title.textContent = 'Activity goals';
  block.appendChild(title);

  const hint1 = document.createElement('div');
  hint1.className = 'settings-row-desc';
  hint1.textContent = 'Time spent on an activity also counts toward your daily total.';
  block.appendChild(hint1);

  const hint2 = document.createElement('div');
  hint2.className = 'settings-row-desc';
  hint2.textContent = 'Goals repeat every day. Changes apply to today, including time you already logged.';
  block.appendChild(hint2);

  const rowsContainer = document.createElement('div');
  rowsContainer.className = 'settings-goals-rows';
  block.appendChild(rowsContainer);

  const sumHint = document.createElement('p');
  sumHint.className = 'settings-goals-sum-hint';
  sumHint.textContent = 'Your activity goals add up to more than your daily goal. That is fine, they are independent.';
  block.appendChild(sumHint);

  const actions = document.createElement('div');
  actions.className = 'settings-goals-actions';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'settings-goal-add';
  addBtn.textContent = 'Add activity goal';
  actions.appendChild(addBtn);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'settings-goal-save';
  saveBtn.textContent = 'Save goals';
  actions.appendChild(saveBtn);

  block.appendChild(actions);

  function updateAddButtonState(): void {
    const usedKeys = new Set(draft.map(row => row.key).filter(key => key !== ''));
    addBtn.disabled = usedKeys.size >= availableKeys.length;
  }

  function updateSumHint(): void {
    const sum = draft.reduce((total, row) => {
      if (row.key === '' || row.key === 'active') return total;
      const num = Number(row.minutes);
      return total + (Number.isFinite(num) ? num : 0);
    }, 0);
    sumHint.hidden = sum <= settings.dailyGoalMinutes;
  }

  function buildRow(row: DraftRow, index: number): HTMLElement {
    const rowEl = document.createElement('div');
    rowEl.className = 'settings-activity-goal-row';

    const select = document.createElement('select');
    select.className = 'settings-goal-input';

    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = 'Choose';
    select.appendChild(emptyOpt);

    for (const key of availableKeys) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = ACTIVITY_GOAL_LABELS[key];
      opt.disabled = draft.some((other, j) => j !== index && other.key === key);
      select.appendChild(opt);
    }
    select.value = row.key;

    select.addEventListener('change', () => {
      draft[index].key = select.value as ActivityGoalKey | '';
      rerender();
    });

    const input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'decimal';
    input.className = 'settings-goal-input';
    applyUnit(input, row);

    const convert = document.createElement('span');
    convert.className = 'settings-goal-convert';
    convert.textContent = previewText(row.minutes);

    input.addEventListener('input', () => {
      const raw = input.value;
      row.minutes = raw === '' ? '' : row.useHours ? String(Math.round(Number(raw) * 60)) : raw;
      convert.textContent = previewText(row.minutes);
      updateSumHint();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
    });

    const unit = document.createElement('button');
    unit.type = 'button';
    unit.className = 'settings-goal-unit';
    unit.textContent = row.useHours ? 'hr' : 'min';
    unit.addEventListener('click', () => {
      row.useHours = !row.useHours;
      unit.textContent = row.useHours ? 'hr' : 'min';
      applyUnit(input, row);
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'custom-site-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      draft.splice(index, 1);
      rerender();
    });

    const error = document.createElement('p');
    error.className = 'settings-goal-error';

    const field = document.createElement('div');
    field.className = 'settings-goal-field';
    field.append(input, unit, convert);

    rowEl.appendChild(select);
    rowEl.appendChild(field);
    rowEl.appendChild(removeBtn);
    rowEl.appendChild(error);
    return rowEl;
  }

  function renderRows(): void {
    rowsContainer.replaceChildren();
    draft.forEach((row, index) => rowsContainer.appendChild(buildRow(row, index)));
  }

  function rerender(): void {
    renderRows();
    updateAddButtonState();
    updateSumHint();
  }

  addBtn.addEventListener('click', () => {
    draft.push({ key: '', minutes: '', useHours: false });
    rerender();
  });

  async function handleSave(): Promise<void> {
    const rowEls = Array.from(rowsContainer.querySelectorAll<HTMLElement>('.settings-activity-goal-row'));
    const seen = new Map<ActivityGoalKey, number>();
    for (const row of draft) {
      if (row.key === '') continue;
      seen.set(row.key, (seen.get(row.key) ?? 0) + 1);
    }

    let hasError = false;
    const byActivity: Partial<Record<ActivityType, number>> = {};
    let activeMinutes: number | null = null;

    draft.forEach((row, index) => {
      const rowEl = rowEls[index];
      const selectEl = rowEl.querySelector('select') as HTMLSelectElement;
      const inputEl = rowEl.querySelector('input') as HTMLInputElement;
      const errorEl = rowEl.querySelector('.settings-goal-error') as HTMLElement;
      selectEl.classList.remove('is-invalid');
      inputEl.classList.remove('is-invalid');
      errorEl.textContent = '';

      const messages: string[] = [];
      const key = row.key;
      if (key === '') {
        selectEl.classList.add('is-invalid');
        messages.push('Choose an activity');
      } else if ((seen.get(key) ?? 0) > 1) {
        selectEl.classList.add('is-invalid');
        messages.push('This activity is already used above');
      }

      const minutesError = validateGoalMinutes(Number(row.minutes));
      if (minutesError) {
        inputEl.classList.add('is-invalid');
        messages.push(minutesError);
      }

      if (messages.length > 0) {
        errorEl.textContent = messages.join(' ');
        hasError = true;
        return;
      }

      const minutes = Math.round(Number(row.minutes));
      if (key === 'active') activeMinutes = minutes;
      else if (key !== '') byActivity[key] = minutes;
    });

    if (hasError) {
      showStatus(container, 'Fix the marked goals first', 'error');
      return;
    }

    saveBtn.disabled = true;
    try {
      // keep the value when the row is hidden
      const finalActive = attentionAllowed ? activeMinutes : existingActiveMinutes;
      const dailyGoals: DailyGoals = { v: 1, byActivity, activeMinutes: finalActive };
      await updateSettings({ dailyGoals, dailyGoalsTouched: true });
      showStatus(container, 'Activity goals saved', 'success');
      void refreshActivityGoals();
    } finally {
      saveBtn.disabled = false;
    }
  }

  saveBtn.addEventListener('click', () => { void handleSave(); });

  rerender();
  container.appendChild(block);
}
