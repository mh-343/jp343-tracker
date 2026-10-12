import { isJapaneseGsmSession } from './classify';

export const GSM_RULE = 'gsm-v1';

const SESSION_GAP_S = 1800;
const MAX_PAIR_GAP_S = 300;
const MIN_SAMPLE_LENGTH = 5;
const MAX_SESSION_S = 86400;

export interface GsmLine {
  id: string;
  // epoch seconds with fraction
  timestamp: number;
  game: string;
  length: number;
  script: boolean;
  kana: boolean;
  // counted before the text is dropped
  chars?: number;
  textHash?: number;
}

export interface GsmSession {
  sessionId: string;
  firstLineId: string;
  game: string;
  start: number;
  end: number;
  seconds: number;
  lines: number;
  linesScript: number;
  linesKana: number;
  // undefined when a line has no count
  chars?: number;
}

export interface GsmWireTimes {
  startUtc: number;
  endUtc: number;
  durationSeconds: number;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return 0;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function lineCap(length: number, pace: number): number {
  if (length <= 0) return 0;
  const cap = pace > 0 ? Math.max(2, (length / pace) * 2.5) : Math.max(2, length * 3);
  return Math.min(cap, MAX_PAIR_GAP_S);
}

function compareLines(a: GsmLine, b: GsmLine): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function groupLines(lines: GsmLine[]): GsmLine[][] {
  const groups: GsmLine[][] = [];
  let current: GsmLine[] = [];
  for (const line of [...lines].sort(compareLines)) {
    const last = current[current.length - 1];
    if (last && (line.timestamp - last.timestamp > SESSION_GAP_S || line.game !== last.game)) {
      groups.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length) groups.push(current);
  return groups;
}

// pace median comes from the unsplit group
function splitGroup(group: GsmLine[]): Array<{ lines: GsmLine[]; seconds: number }> {
  const samples: number[] = [];
  for (let i = 0; i < group.length - 1; i++) {
    const gap = group[i + 1].timestamp - group[i].timestamp;
    if (group[i].length >= MIN_SAMPLE_LENGTH && gap >= 1 && gap <= MAX_PAIR_GAP_S) samples.push(group[i].length / gap);
  }
  const pace = median(samples);
  const parts: Array<{ lines: GsmLine[]; seconds: number }> = [];
  let begin = 0;
  let seconds = 0;
  for (let i = 0; i < group.length - 1; i++) {
    const add = Math.min(group[i + 1].timestamp - group[i].timestamp, lineCap(group[i].length, pace));
    if (seconds + add > MAX_SESSION_S) {
      parts.push({ lines: group.slice(begin, i + 1), seconds });
      begin = i + 1;
      seconds = 0;
    } else {
      seconds += add;
    }
  }
  parts.push({ lines: group.slice(begin), seconds });
  return parts;
}

// each text once per session; not Japanese gives 0
export function gsmSessionChars(lines: GsmLine[], linesScript: number, linesKana: number): number | undefined {
  if (!isJapaneseGsmSession(linesScript, linesKana)) return 0;
  const seen = new Set<number>();
  let total = 0;
  for (const line of lines) {
    if (line.chars === undefined || line.textHash === undefined) return undefined;
    if (seen.has(line.textHash)) continue;
    seen.add(line.textHash);
    total += line.chars;
  }
  return total;
}

export async function gsmV1Sessions(lines: GsmLine[]): Promise<GsmSession[]> {
  const sessions: GsmSession[] = [];
  for (const group of groupLines(lines)) {
    for (const part of splitGroup(group)) {
      const first = part.lines[0];
      const last = part.lines[part.lines.length - 1];
      const linesScript = part.lines.filter(line => line.script).length;
      const linesKana = part.lines.filter(line => line.kana).length;
      const chars = gsmSessionChars(part.lines, linesScript, linesKana);
      sessions.push({
        sessionId: 'gsm-' + (await sha256Hex(first.id)).slice(0, 32),
        firstLineId: first.id,
        game: first.game,
        start: first.timestamp,
        end: last.timestamp,
        seconds: part.seconds,
        lines: part.lines.length,
        linesScript,
        linesKana,
        ...(chars === undefined ? {} : { chars }),
      });
    }
  }
  return sessions;
}

// floor start, ceil end: duration never exceeds the span
export function gsmWireTimes(session: GsmSession): GsmWireTimes {
  return {
    startUtc: Math.floor(session.start),
    endUtc: Math.ceil(session.end),
    durationSeconds: Math.round(session.seconds),
  };
}
