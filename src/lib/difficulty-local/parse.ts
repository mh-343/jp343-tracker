// json3 -> text + timing (port of parse.mjs, in-memory input)
import type { Json3Transcript, ParsedTranscript } from './types';

export function parseJson3(data: Json3Transcript): ParsedTranscript | null {
  const events = (data.events || []).filter((e) => e.segs && e.segs.length);
  if (!events.length) return null;

  let text = '';
  for (const e of events) for (const s of e.segs!) text += s.utf8 || '';

  let start = Infinity;
  let end = -Infinity;
  for (const e of events) {
    start = Math.min(start, e.tStartMs);
    end = Math.max(end, e.tStartMs + (e.dDurationMs || 0));
  }

  // interval union, no double-count of overlaps
  const iv = events
    .map((e) => [e.tStartMs, e.tStartMs + (e.dDurationMs || 0)] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let activeMs = 0;
  let curS = iv[0][0];
  let curE = iv[0][1];
  for (let i = 1; i < iv.length; i++) {
    const [s, t] = iv[i];
    if (s > curE) {
      activeMs += curE - curS;
      curS = s;
      curE = t;
    } else {
      curE = Math.max(curE, t);
    }
  }
  activeMs += curE - curS;

  return { text, spanMin: (end - start) / 60000, activeMin: activeMs / 60000 };
}
