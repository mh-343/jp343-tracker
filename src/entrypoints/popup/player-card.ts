import type { MpchcStatus, PlayerLive } from '../../lib/mpchc';
import { formatDurationMs } from '../../lib/format-utils';
import { PLATFORM_ICONS, PLATFORM_LABELS } from '../../lib/platform-labels';
import type { LivePlayerInput } from './today-live';

const HINT = 'Controlled in MPC-HC. Saves when you stop or the video ends.';
const IDLE_HINT = 'Visit a supported streaming site or play a video in MPC-HC';

export interface HeaderStatus {
  className: string;
  text: string;
}

export function playerDisplayMs(player: PlayerLive, now: number): number {
  const session = player.session;
  if (!session) return 0;
  if (player.status !== 'playing' || !session.lastPlaying) return session.accumulatedMs;
  return session.accumulatedMs + Math.max(0, Math.min(now - session.lastPollAt, 2 * player.periodMs));
}

export function playerStateLabel(status: MpchcStatus): string {
  if (status === 'playing') return `${PLATFORM_LABELS.mpchc} · Playing`;
  if (status === 'paused') return `${PLATFORM_LABELS.mpchc} · Paused`;
  return `${PLATFORM_LABELS.mpchc} · Stopped, saving shortly`;
}

export function playerHeaderStatus(status: MpchcStatus): HeaderStatus {
  if (status === 'playing') return { className: 'status-dot recording', text: 'REC' };
  if (status === 'paused') return { className: 'status-dot paused', text: 'Paused' };
  return { className: 'status-dot', text: 'Idle' };
}

function fileStem(file: string): string {
  return file.replace(/\.[^.]+$/, '') || file;
}

export function createPlayerCard(root: HTMLElement) {
  const info = document.createElement('div');
  info.className = 'session-info';
  const thumb = document.createElement('div');
  thumb.className = 'session-thumbnail placeholder';
  const icon = document.createElement('span');
  icon.textContent = PLATFORM_ICONS.mpchc;
  thumb.appendChild(icon);
  const details = document.createElement('div');
  details.className = 'session-details';
  const title = document.createElement('div');
  title.className = 'session-title';
  const platform = document.createElement('div');
  platform.className = 'session-platform';
  details.append(title, platform);
  info.append(thumb, details);
  const timer = document.createElement('div');
  timer.className = 'session-timer';
  const hint = document.createElement('div');
  hint.className = 'player-hint';
  hint.textContent = HINT;
  root.append(info, timer, hint);

  let player: PlayerLive | null = null;
  let hidden = true;
  let shownId = '';
  let lastSecond = -1;

  function visible(): boolean {
    return !hidden && !!player?.session;
  }

  function renderTimer(): void {
    if (!player?.session) return;
    if (player.session.id !== shownId) {
      shownId = player.session.id;
      lastSecond = -1;
    }
    const second = Math.floor(playerDisplayMs(player, Date.now()) / 1000);
    if (second < lastSecond) return;
    lastSecond = second;
    timer.textContent = formatDurationMs(second * 1000);
  }

  return {
    update(next: PlayerLive | null, hasBrowserSession: boolean): void {
      player = next;
      hidden = hasBrowserSession || !next?.session;
      root.style.display = visible() ? 'block' : 'none';
      if (!visible() || !next?.session) return;
      title.textContent = fileStem(next.session.file);
      title.title = next.session.file;
      platform.textContent = playerStateLabel(next.status);
      renderTimer();
    },
    tick(): void {
      if (visible()) renderTimer();
    },
    visible,
    headerStatus(): HeaderStatus | null {
      return visible() && player ? playerHeaderStatus(player.status) : null;
    },
    placeholderHint(): string | null {
      if (!player || player.session) return null;
      return player.status === 'idle' || player.status === 'paused' ? IDLE_HINT : null;
    },
    liveInput(): LivePlayerInput | null {
      if (!player?.session) return null;
      return { id: player.session.id, startTime: player.session.startedAt, measuredMs: playerDisplayMs(player, Date.now()) };
    }
  };
}
