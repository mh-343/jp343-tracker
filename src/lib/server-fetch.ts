export interface ServerResponse {
  success?: boolean;
  data?: Record<string, unknown>;
}

export interface RefreshState {
  inFlight: Promise<void> | null;
  lastAttempt: number;
}

const DEBUG_MODE = import.meta.env.DEV;
const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface PostOptions {
  credentials: 'omit' | 'include';
  retries?: number;
  timeoutMs?: number;
}

export async function postJsonWithRetry(
  ajaxUrl: string,
  params: URLSearchParams,
  label: string,
  options: PostOptions
): Promise<ServerResponse | null> {
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 10000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(ajaxUrl, {
        method: 'POST',
        credentials: options.credentials,
        signal: controller.signal,
        body: params
      });
      if (response.ok) return await response.json() as ServerResponse;
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        log(`[JP343] ${label}: HTTP ${response.status}, not retrying`);
        return null;
      }
      log(`[JP343] ${label}: HTTP ${response.status} (try ${attempt + 1}/${retries + 1})`);
    } catch (error) {
      log(`[JP343] ${label}: fetch failed (try ${attempt + 1}/${retries + 1})`, error);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await delay(400 * (attempt + 1));
  }
  return null;
}

export function coalesceRefresh(
  state: RefreshState,
  throttleMs: number,
  force: boolean,
  run: () => Promise<void>
): Promise<void> {
  if (state.inFlight && !force) return state.inFlight;
  if (!state.inFlight && !force && Date.now() - state.lastAttempt < throttleMs) {
    return Promise.resolve();
  }

  // force queues, never joins
  const previous = state.inFlight ?? Promise.resolve();
  const chained = previous
    .then(() => {
      state.lastAttempt = Date.now();
      return run();
    })
    .catch(error => { log('[JP343] cache refresh failed', error); });

  state.inFlight = chained;
  chained.finally(() => { if (state.inFlight === chained) state.inFlight = null; });
  return chained;
}
