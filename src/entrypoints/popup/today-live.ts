import type { ActivityType, AttentionCounters, AttentionHold, AttentionMode, AttentionSample } from '../../types';
import { flushAttentionHold, passiveShare } from '../../lib/attention';
import { getLocalDateString, getWeekDates } from '../../lib/format-utils';

export interface LiveBase {
  liveSessionId: string | null;
  livePlayerSessionId: string | null;
  dayKey: string;
  dayStartHour: number;
  todayMinutes: number;
  weekMinutes: number;
  byActivity: Partial<Record<ActivityType, number>>;
  activeMinutes: number;
  dailyMinutes: Record<string, number>;
}

export interface LiveSessionInput {
  id: string;
  startTime: number;
  measuredMs: number;
  activityType?: ActivityType;
  attention?: AttentionMode;
  attentionOverride?: AttentionMode;
  attnCounters?: AttentionCounters;
  attnHold?: AttentionHold;
  attnLast?: AttentionSample;
}

export interface LivePlayerInput {
  id: string;
  startTime: number;
  measuredMs: number;
}

export interface LiveDisplay {
  todayMinutes: number;
  weekMinutes: number;
  byActivity: Partial<Record<ActivityType, number>>;
  activeMinutes: number;
  dailyMinutes: Record<string, number>;
}

export interface TodayLiveOptions {
  getDayStartHour: () => number;
  getVisibleActive?: () => boolean;
  onNeedRefresh: () => void;
  onDisplay: (display: LiveDisplay) => void;
}

interface Contribution {
  startDay: string;
  minutes: number;
  todayLive: number;
  weekLive: number;
}

function contribution(input: { startTime: number; measuredMs: number } | null, dsh: number, today: string): Contribution {
  if (!input) return { startDay: '', minutes: 0, todayLive: 0, weekLive: 0 };
  const startDay = getLocalDateString(new Date(input.startTime), dsh);
  const minutes = Number.isFinite(input.measuredMs) ? Math.max(0, input.measuredMs) / 60_000 : 0;
  return {
    startDay,
    minutes,
    todayLive: startDay === today ? minutes : 0,
    weekLive: getWeekDates(dsh).some(day => day.date === startDay) ? minutes : 0
  };
}

function liveActiveMinutes(session: LiveSessionInput | null, todayLive: number, visibleActive: boolean): number {
  if (!session) return 0;
  if (session.attentionOverride) return session.attentionOverride === 'active' ? todayLive : 0;
  if (session.attnCounters) {
    const flushed = flushAttentionHold({ counters: session.attnCounters, hold: session.attnHold, last: session.attnLast });
    const c = flushed.counters ?? session.attnCounters;
    if (c.focusMs + c.visibleMs + c.hiddenMs > 0) {
      const share = passiveShare({
        attnFocusSec: c.focusMs / 1000,
        attnVisibleSec: c.visibleMs / 1000,
        attnHiddenSec: c.hiddenMs / 1000,
        activityType: session.activityType
      }, visibleActive);
      return todayLive * (1 - (share ?? 0));
    }
  }
  return session.attention === 'active' ? todayLive : 0;
}

export function createTodayLive(options: TodayLiveOptions) {
  let base: LiveBase | null = null;
  let session: LiveSessionInput | null = null;
  let player: LivePlayerInput | null = null;
  let signature = '';

  function render(force = false, requestRefresh = true): void {
    const dsh = options.getDayStartHour();
    const today = getLocalDateString(new Date(), dsh);
    if (!base || base.liveSessionId !== (session?.id ?? null)
        || base.livePlayerSessionId !== (player?.id ?? null)
        || base.dayKey !== today || base.dayStartHour !== dsh) {
      if (requestRefresh) options.onNeedRefresh();
      return;
    }

    const browser = contribution(session, dsh, today);
    const local = contribution(player, dsh, today);
    const byActivity = { ...base.byActivity };
    if (session?.activityType && browser.todayLive > 0) {
      byActivity[session.activityType] = (byActivity[session.activityType] ?? 0) + browser.todayLive;
    }
    if (local.todayLive > 0) byActivity.watching = (byActivity.watching ?? 0) + local.todayLive;
    for (const key of Object.keys(byActivity) as ActivityType[]) {
      byActivity[key] = Math.floor(byActivity[key] ?? 0);
    }
    const dailyMinutes = { ...base.dailyMinutes };
    for (const part of [browser, local]) {
      if (part.startDay) dailyMinutes[part.startDay] = (dailyMinutes[part.startDay] ?? 0) + part.minutes;
    }
    const todayMinutes = Math.floor(base.todayMinutes + browser.todayLive + local.todayLive);
    dailyMinutes[today] = todayMinutes;
    for (const day of Object.keys(dailyMinutes)) dailyMinutes[day] = Math.floor(dailyMinutes[day]);

    // player time carries no attention, like its saved entry
    const liveActive = liveActiveMinutes(session, browser.todayLive, options.getVisibleActive?.() ?? false);
    const display: LiveDisplay = {
      todayMinutes,
      weekMinutes: Math.floor(base.weekMinutes + browser.weekLive + local.weekLive),
      byActivity,
      activeMinutes: Math.floor(base.activeMinutes + liveActive),
      dailyMinutes
    };
    const nextSignature = JSON.stringify(display);
    if (force || signature !== nextSignature) {
      signature = nextSignature;
      options.onDisplay(display);
    }
  }

  return {
    setBase(next: LiveBase): void {
      base = next;
      render(true, false);
    },
    setSession(next: LiveSessionInput | null): void {
      session = next;
      render();
    },
    setPlayerSession(next: LivePlayerInput | null): void {
      player = next;
      render();
    }
  };
}
