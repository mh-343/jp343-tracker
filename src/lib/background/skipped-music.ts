export interface SkippedMusicInfo { videoId: string | null; title: string; }
let current: SkippedMusicInfo | null = null;
export function setSkippedMusic(info: SkippedMusicInfo | null): void { current = info; }
export function getSkippedMusic(): SkippedMusicInfo | null { return current; }
