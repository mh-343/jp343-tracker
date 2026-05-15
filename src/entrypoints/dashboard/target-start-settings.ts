import type { ExtensionSettings } from '../../types';
import { DEFAULT_SETTINGS } from '../../types';

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

async function updateSettings(patch: Partial<ExtensionSettings>): Promise<void> {
  const response = await browser.runtime.sendMessage({ type: 'GET_SETTINGS' });
  const current = (response.success && response.data?.settings)
    ? response.data.settings as ExtensionSettings
    : { ...DEFAULT_SETTINGS };
  await browser.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: { ...current, ...patch } });
}

export function buildTargetStartSection(container: HTMLElement, settings: ExtensionSettings): void {
  const section = document.createElement('div');
  section.className = 'settings-section';

  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'Target Start Time';
  section.appendChild(title);

  const desc = document.createElement('div');
  desc.className = 'settings-row-desc';
  desc.style.marginBottom = '8px';
  desc.textContent = 'Set daily target times for when you want to start immersing.';
  section.appendChild(desc);

  const times = [...(settings.targetStartTimes ?? DEFAULT_SETTINGS.targetStartTimes)];
  const selected = new Set<number>();

  const pillRow = document.createElement('div');
  pillRow.className = 'day-pill-row';

  const timeInput = document.createElement('input');
  timeInput.type = 'time';
  timeInput.className = 'day-time-input';
  timeInput.style.display = 'none';

  const pills: HTMLElement[] = [];

  function updatePillDisplay(idx: number, pill: HTMLElement): void {
    const timeLabel = pill.querySelector('.pill-time') as HTMLElement;
    if (times[idx]) {
      timeLabel.textContent = times[idx]!;
      timeLabel.style.display = '';
      pill.classList.add('has-target');
    } else {
      timeLabel.textContent = '';
      timeLabel.style.display = 'none';
      pill.classList.remove('has-target');
    }
  }

  function syncTimeInput(): void {
    if (selected.size === 0) {
      timeInput.style.display = 'none';
      return;
    }
    timeInput.style.display = '';
    const firstSelected = Math.min(...selected);
    timeInput.value = times[firstSelected] || '';
  }

  for (let i = 0; i < 7; i++) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'day-pill';

    const label = document.createElement('span');
    label.className = 'pill-label';
    label.textContent = DAY_LABELS[i];

    const timeLabel = document.createElement('span');
    timeLabel.className = 'pill-time';

    pill.appendChild(label);
    pill.appendChild(timeLabel);

    pill.addEventListener('click', () => {
      if (selected.has(i)) {
        selected.delete(i);
        pill.classList.remove('active');
      } else {
        selected.add(i);
        pill.classList.add('active');
      }
      syncTimeInput();
    });

    pillRow.appendChild(pill);
    pills.push(pill);
    updatePillDisplay(i, pill);
  }

  section.appendChild(pillRow);

  timeInput.addEventListener('change', async () => {
    const val = timeInput.value || null;
    for (const idx of selected) {
      times[idx] = val;
      updatePillDisplay(idx, pills[idx]);
    }
    await updateSettings({ targetStartTimes: [...times] });
  });

  section.appendChild(timeInput);

  const quickRow = document.createElement('div');
  quickRow.className = 'day-quick-row';

  const weekdaysBtn = document.createElement('button');
  weekdaysBtn.type = 'button';
  weekdaysBtn.className = 'day-quick-btn';
  weekdaysBtn.textContent = 'Select Weekdays';
  weekdaysBtn.addEventListener('click', () => {
    selected.clear();
    for (let i = 0; i < 7; i++) pills[i].classList.remove('active');
    for (const d of [1, 2, 3, 4, 5]) {
      selected.add(d);
      pills[d].classList.add('active');
    }
    syncTimeInput();
  });

  const weekendBtn = document.createElement('button');
  weekendBtn.type = 'button';
  weekendBtn.className = 'day-quick-btn';
  weekendBtn.textContent = 'Select Weekend';
  weekendBtn.addEventListener('click', () => {
    selected.clear();
    for (let i = 0; i < 7; i++) pills[i].classList.remove('active');
    for (const d of [0, 6]) {
      selected.add(d);
      pills[d].classList.add('active');
    }
    syncTimeInput();
  });

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'day-quick-btn';
  clearBtn.textContent = 'Clear All';
  clearBtn.addEventListener('click', async () => {
    selected.clear();
    for (let i = 0; i < 7; i++) {
      times[i] = null;
      pills[i].classList.remove('active');
      updatePillDisplay(i, pills[i]);
    }
    timeInput.style.display = 'none';
    timeInput.value = '';
    await updateSettings({ targetStartTimes: [...times] });
  });

  quickRow.appendChild(weekdaysBtn);
  quickRow.appendChild(weekendBtn);
  quickRow.appendChild(clearBtn);
  section.appendChild(quickRow);

  container.appendChild(section);
}
