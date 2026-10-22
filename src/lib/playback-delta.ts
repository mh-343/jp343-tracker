const MAX_STEP_SECONDS = 10;
const SEEK_SLACK_SECONDS = 1;

// outran the wall clock: a seek, not watching
export function playbackDeltaMs(mediaStep: number, wallStepMs: number, rate: number): number {
  if (mediaStep <= 0 || mediaStep > MAX_STEP_SECONDS) return 0;
  const speed = rate || 1;
  if (mediaStep > (wallStepMs / 1000) * speed + SEEK_SLACK_SECONDS) return 0;
  return (mediaStep / speed) * 1000;
}
