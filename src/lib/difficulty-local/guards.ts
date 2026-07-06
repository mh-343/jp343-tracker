// content guards (port of guards.py, query-time)

const MUSIC_PATTERNS = [
  '(?<![a-z0-9])mv(?![a-z0-9])',
  '(?<![a-z0-9])pv(?![a-z0-9])',
  'music\\s*video',
  'official\\s*(music\\s*)?video',
  'official\\s*audio',
  'lyric\\s*video',
  'karaoke',
  'covered\\s+by',
  '歌ってみた',
  '歌わせて',
  '弾いてみた',
  '歌詞',
  'カラオケ',
];
const MUSIC_TITLE_RE = new RegExp(MUSIC_PATTERNS.join('|'));
const LOW_SPEECH_RATIO = 0.25;

function normTitle(title: string): string {
  return (title || '').normalize('NFKC').toLowerCase();
}

export function isMusicTitle(title: string): boolean {
  return MUSIC_TITLE_RE.test(normTitle(title));
}

// true = guarded (low speech)
export function transcriptGuard(activeMin: number, durationSec: number | null): boolean {
  if (durationSec && activeMin / (durationSec / 60) < LOW_SPEECH_RATIO) return true;
  return false;
}
