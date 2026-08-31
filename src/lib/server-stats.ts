export interface DecrementableServerStats {
  total_seconds?: number;
  today_seconds?: number;
  week_seconds?: number;
  calendar_week_seconds?: number;
  calendar_week_active_seconds?: number;
  calendar_week_passive_seconds?: number;
  timezone?: string;
}

export function subtractSessionFromServerStats(
  stats: DecrementableServerStats,
  deltaSeconds: number,
  sessionDateStr: string,
  todayStr: string,
  weekStartStr: string,
  weekEndStr: string,
  browserTz: string,
  isPassive?: boolean
): void {
  if (stats.total_seconds) stats.total_seconds = Math.max(0, stats.total_seconds - deltaSeconds);

  const tzMatch = !stats.timezone || stats.timezone === browserTz;
  if (sessionDateStr === todayStr && stats.today_seconds && tzMatch) {
    stats.today_seconds = Math.max(0, stats.today_seconds - deltaSeconds);
  }

  if (weekStartStr && sessionDateStr >= weekStartStr && sessionDateStr <= weekEndStr) {
    if (stats.calendar_week_seconds !== undefined) {
      stats.calendar_week_seconds = Math.max(0, stats.calendar_week_seconds - deltaSeconds);
    } else if (stats.week_seconds) {
      stats.week_seconds = Math.max(0, stats.week_seconds - deltaSeconds);
    }
    if (isPassive === true && stats.calendar_week_passive_seconds !== undefined) {
      stats.calendar_week_passive_seconds = Math.max(0, stats.calendar_week_passive_seconds - deltaSeconds);
    } else if (isPassive === false && stats.calendar_week_active_seconds !== undefined) {
      stats.calendar_week_active_seconds = Math.max(0, stats.calendar_week_active_seconds - deltaSeconds);
    }
  }
}
