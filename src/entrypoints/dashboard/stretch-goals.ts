import { formatStatDuration } from '../../lib/format-utils';

interface StretchLevel {
  level: number;
  multiplier: number;
  label: string;
}

const STRETCH_LEVELS: StretchLevel[] = [
  { level: 1, multiplier: 1.0, label: 'Daily Goal' },
  { level: 2, multiplier: 1.5, label: '150%' },
  { level: 3, multiplier: 2.0, label: '200%' },
  { level: 4, multiplier: 2.5, label: '250%' },
  { level: 5, multiplier: 3.0, label: '300%' },
];

type StretchState = 'locked' | 'charging' | 'unlocked';

function getState(todayMinutes: number, prevTarget: number, target: number): StretchState {
  if (todayMinutes >= target) return 'unlocked';
  if (todayMinutes >= prevTarget) return 'charging';
  return 'locked';
}

function getProgress(todayMinutes: number, prevTarget: number, target: number): number {
  if (todayMinutes >= target) return 100;
  if (todayMinutes < prevTarget) return 0;
  const range = target - prevTarget;
  if (range <= 0) return 0;
  return Math.round(((todayMinutes - prevTarget) / range) * 100);
}

function createSlide(
  level: StretchLevel, state: StretchState, progress: number,
  todayMinutes: number, target: number
): HTMLElement {
  const slide = document.createElement('div');
  slide.className = 'stretch-slide';
  slide.dataset.state = state;
  slide.dataset.level = String(level.level);

  const header = document.createElement('div');
  header.className = 'stretch-slide-header';

  const label = document.createElement('span');
  label.className = 'stretch-slide-label';
  if (level.level === 1) {
    label.textContent = `\u2713 ${level.label}`;
  } else {
    const icon = state === 'unlocked' ? '\u2713' : '\u26A1';
    label.textContent = `${icon} Level ${level.level} \u00B7 ${level.label}`;
  }

  const stats = document.createElement('span');
  stats.className = 'stretch-slide-stats';

  const done = document.createElement('span');
  done.className = 'stretch-slide-done';
  done.textContent = formatStatDuration(todayMinutes);

  const pct = document.createElement('span');
  pct.className = 'stretch-slide-pct';
  pct.textContent = ` / ${formatStatDuration(target)} (${progress}%)`;

  stats.appendChild(done);
  stats.appendChild(pct);
  header.appendChild(label);
  header.appendChild(stats);

  const track = document.createElement('div');
  track.className = 'stretch-slide-track';

  const fill = document.createElement('div');
  fill.className = 'stretch-slide-fill';
  if (progress > 100) {
    fill.style.width = '100%';
    fill.classList.add('overflow');
    track.classList.add('overflow');
    const cutoff = Math.round((100 / progress) * 100);
    fill.style.setProperty('--goal-cutoff', `${cutoff}%`);
  } else {
    fill.style.width = `${progress}%`;
  }
  track.appendChild(fill);

  slide.appendChild(header);
  slide.appendChild(track);

  return slide;
}

let activeIndex = -1;

function findActiveIndex(states: StretchState[]): number {
  const chargingIdx = states.indexOf('charging');
  if (chargingIdx !== -1) return chargingIdx;
  const lastUnlocked = states.lastIndexOf('unlocked');
  if (lastUnlocked !== -1) return Math.min(lastUnlocked + 1, states.length - 1);
  return 0;
}

function showSlide(container: HTMLElement, index: number): void {
  const slides = container.querySelectorAll('.stretch-slide');
  const dots = container.querySelectorAll('.stretch-dot');
  const direction = index > activeIndex ? 'slide-left' : index < activeIndex ? 'slide-right' : '';
  slides.forEach((s, i) => {
    const el = s as HTMLElement;
    el.classList.remove('active', 'slide-left', 'slide-right');
    if (i === index) {
      if (direction) el.classList.add(direction);
      el.classList.add('active');
    }
  });
  dots.forEach((d, i) => d.classList.toggle('active', i === index));
  activeIndex = index;
}

function setupInteraction(container: HTMLElement): void {
  let startX = 0;
  let startY = 0;
  const slider = container.querySelector('.stretch-slider');
  if (!slider) return;
  const max = STRETCH_LEVELS.length - 1;

  function navigate(direction: 1 | -1): void {
    const next = activeIndex + direction;
    if (next >= 0 && next <= max) showSlide(container, next);
  }

  slider.addEventListener('touchstart', (e) => {
    const touch = (e as TouchEvent).touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
  }, { passive: true });

  slider.addEventListener('touchend', (e) => {
    const touch = (e as TouchEvent).changedTouches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (Math.abs(dx) < 40 || Math.abs(dy) > Math.abs(dx)) return;
    navigate(dx < 0 ? 1 : -1);
  }, { passive: true });

  let wheelCooldown = false;
  slider.addEventListener('wheel', (e) => {
    const we = e as WheelEvent;
    const delta = Math.abs(we.deltaX) > Math.abs(we.deltaY) ? we.deltaX : we.deltaY;
    if (delta === 0 || wheelCooldown) return;
    const direction: 1 | -1 = delta > 0 ? 1 : -1;
    const next = activeIndex + direction;
    if (next < 0 || next > max) return;
    we.preventDefault();
    navigate(direction);
    wheelCooldown = true;
    setTimeout(() => { wheelCooldown = false; }, 250);
  });
}

export function renderStretchGoals(todayMinutes: number, goalMinutes: number, enabled: boolean): void {
  const container = document.getElementById('stretchGoals');
  if (!container) return;

  container.textContent = '';
  container.classList.remove('visible');

  const safeGoal = goalMinutes || 60;
  if (!enabled || todayMinutes < safeGoal) return;

  const slider = document.createElement('div');
  slider.className = 'stretch-slider';

  const states: StretchState[] = [];
  let prevTarget = 0;

  for (const level of STRETCH_LEVELS) {
    const target = Math.round(safeGoal * level.multiplier);
    const state = getState(todayMinutes, prevTarget, target);
    const isLastLevel = level === STRETCH_LEVELS[STRETCH_LEVELS.length - 1];
    const progress = isLastLevel && state === 'unlocked'
      ? Math.round((todayMinutes / target) * 100)
      : getProgress(todayMinutes, prevTarget, target);
    states.push(state);
    slider.appendChild(createSlide(level, state, progress, todayMinutes, target));
    prevTarget = target;
  }

  const dots = document.createElement('div');
  dots.className = 'stretch-dots';

  for (let i = 0; i < STRETCH_LEVELS.length; i++) {
    const dot = document.createElement('button');
    dot.className = 'stretch-dot';
    dot.type = 'button';
    dot.dataset.state = states[i];
    dot.dataset.level = String(STRETCH_LEVELS[i].level);
    dot.title = `Level ${STRETCH_LEVELS[i].level}`;
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      showSlide(container, i);
    });
    dots.appendChild(dot);
  }

  container.appendChild(slider);
  container.appendChild(dots);
  container.classList.add('visible');

  const bestIndex = findActiveIndex(states);
  const targetIndex = activeIndex >= 0 && activeIndex < STRETCH_LEVELS.length ? activeIndex : bestIndex;
  showSlide(container, targetIndex);
  setupInteraction(container);
}
