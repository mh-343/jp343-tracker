import type { ActivityType, DailyGoals } from '../types';
import { DAILY_GOAL_MIN_MINUTES, DAILY_GOAL_MAX_MINUTES } from '../types';

export type ActivityGoalKey = ActivityType | 'active';

export const ACTIVITY_GOAL_ORDER: readonly ActivityType[] = ['watching', 'listening', 'reading', 'speaking', 'other'];

export const ACTIVITY_GOAL_LABELS: Record<ActivityGoalKey, string> = {
  watching: 'Watching',
  listening: 'Listening',
  reading: 'Reading',
  speaking: 'Speaking',
  other: 'Other',
  active: 'Active time'
};

// Immersion-mix + active/passive green
export const ACTIVITY_GOAL_COLORS: Partial<Record<ActivityGoalKey, string>> = {
  watching: '#7a4ad8',
  listening: '#e91e8b',
  reading: '#4cc9b0',
  speaking: '#ffb454',
  other: '#8a97a8',
  active: '#2ecc71'
};

export interface ActivityGoalRow {
  key: ActivityGoalKey;
  label: string;
  doneMinutes: number;
  goalMinutes: number;
  percent: number;
  reached: boolean;
}

function buildRow(key: ActivityGoalKey, doneMinutes: number, goalMinutes: number): ActivityGoalRow {
  return {
    key,
    label: ACTIVITY_GOAL_LABELS[key],
    doneMinutes,
    goalMinutes,
    percent: Math.min(100, Math.round((doneMinutes / goalMinutes) * 100)),
    reached: doneMinutes >= goalMinutes
  };
}

export function computeActivityGoalRows(
  goals: DailyGoals | undefined,
  todayByActivity: Partial<Record<ActivityType, number>> | undefined,
  todayActiveMinutes: number,
  attentionEnabled: boolean
): ActivityGoalRow[] {
  const rows: ActivityGoalRow[] = [];
  for (const type of ACTIVITY_GOAL_ORDER) {
    const goalMinutes = goals?.byActivity[type];
    if (goalMinutes === undefined) continue;
    rows.push(buildRow(type, Math.floor(todayByActivity?.[type] ?? 0), goalMinutes));
  }
  const activeGoal = goals?.activeMinutes;
  if (attentionEnabled && activeGoal) {
    rows.push(buildRow('active', Math.floor(todayActiveMinutes), activeGoal));
  }
  return rows;
}

export function validateGoalMinutes(value: number): string | null {
  const isValid = Number.isInteger(value) && value >= DAILY_GOAL_MIN_MINUTES && value <= DAILY_GOAL_MAX_MINUTES;
  return isValid ? null : 'Enter a whole number between 5 and 1440 minutes';
}
