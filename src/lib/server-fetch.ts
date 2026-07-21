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

export async function postJsonWithRetry(
  ajaxUrl: string,
  params: URLSearchParams,
  label: string,
  retries = 2,
  timeoutMs = 10000
): Promise<ServerResponse | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(ajaxUrl, { method: 'POST', signal: controller.signal, body: params });
      if (response.ok) return await response.json() as ServerResponse;
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
  if (state.inFlight) return state.inFlight;
  if (!force && Date.now() - state.lastAttempt < throttleMs) return Promise.resolve();
  state.lastAttempt = Date.now();
  state.inFlight = run()
    .catch(error => { log('[JP343] cache refresh failed', error); })
    .finally(() => { state.inFlight = null; });
  return state.inFlight;
}
