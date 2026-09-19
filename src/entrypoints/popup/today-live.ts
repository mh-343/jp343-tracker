import type { ActivityType, AttentionMode } from '../../types';
import { getLocalDateString, getWeekDates } from '../../lib/format-utils';

export interface LiveBase {
  liveSessionId: string | null;
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
  onNeedRefresh: () => void;
  onDisplay: (display: LiveDisplay) => void;
}

export function createTodayLive(options: TodayLiveOptions) {
  let base: LiveBase | null = null;
  let session: LiveSessionInput | null = null;
  let signature = '';

  function render(force = false, requestRefresh = true): void {
    const dsh = options.getDayStartHour();
    const today = getLocalDateString(new Date(), dsh);
    if (!base || base.liveSessionId !== (session?.id ?? null)
        || base.dayKey !== today || base.dayStartHour !== dsh) {
      if (requestRefresh) options.onNeedRefresh();
      return;
    }

    const startDay = session ? getLocalDateString(new Date(session.startTime), dsh) : '';
    const minutes = session && Number.isFinite(session.measuredMs)
      ? Math.max(0, session.measuredMs) / 60_000 : 0;
    const todayLive = startDay === today ? minutes : 0;
    const weekLive = getWeekDates(dsh).some(day => day.date === startDay) ? minutes : 0;
    const byActivity = { ...base.byActivity };
    if (session?.activityType && todayLive > 0) {
      byActivity[session.activityType] = (byActivity[session.activityType] ?? 0) + todayLive;
    }
    for (const key of Object.keys(byActivity) as ActivityType[]) {
      byActivity[key] = Math.floor(byActivity[key] ?? 0);
    }
    const dailyMinutes = { ...base.dailyMinutes };
    if (startDay) dailyMinutes[startDay] = (dailyMinutes[startDay] ?? 0) + minutes;
    const todayMinutes = Math.floor(base.todayMinutes + todayLive);
    dailyMinutes[today] = todayMinutes;
    for (const day of Object.keys(dailyMinutes)) dailyMinutes[day] = Math.floor(dailyMinutes[day]);

    const attention = session?.attentionOverride ?? session?.attention;
    const display: LiveDisplay = {
      todayMinutes,
      weekMinutes: Math.floor(base.weekMinutes + weekLive),
      byActivity,
      activeMinutes: Math.floor(base.activeMinutes + (attention === 'active' ? todayLive : 0)),
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
    }
  };
}
