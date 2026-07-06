// types for the local difficulty estimator

export interface Json3Segment {
  utf8?: string;
}

export interface Json3Event {
  tStartMs: number;
  dDurationMs?: number;
  segs?: Json3Segment[];
}

export interface Json3Transcript {
  events?: Json3Event[];
}

export interface ParsedTranscript {
  text: string;
  spanMin: number;
  activeMin: number;
}

export interface LocalBand {
  min: number;
  max: number;
  center: number;
  width: number;
  hint: string;
  src: string;
}

export interface AnchorBundle {
  version: number;
  method_version: string;
  kanji_mora: number;
  k: number;
  features: string[];
  norm: { mu: number[]; sd: number[]; lo: number[]; hi: number[] };
  anchors: Array<{ lvl: number; v: number[] }>;
}
