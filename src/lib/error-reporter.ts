import { STORAGE_KEYS } from '../types';

type ErrorContext = 'background' | 'content' | 'dashboard' | 'popup';

interface QueuedError {
  message: string;
  source: string;
  stack: string;
  context: ErrorContext;
  platform?: string;
}

const ERROR_ENDPOINT = 'https://jp343.com/wp-json/jp343/v1/extension/errors';
const MAX_QUEUE = 10;
const FLUSH_INTERVAL_MS = 60_000;

const URL_RE = /https?:\/\/[^\s)]+/g;
const EXT_ID_RE = /([a-z]{32})/g;

let queue: QueuedError[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

function scrubUrls(text: string): string {
  return text.replace(URL_RE, '[URL]');
}

function shortenExtId(text: string): string {
  return text.replace(EXT_ID_RE, (m) => m.slice(0, 8) + '…');
}

function scrub(text: string, maxLen: number): string {
  return shortenExtId(scrubUrls(text)).slice(0, maxLen);
}

export function reportError(
  message: string,
  source: string,
  stack: string,
  context: ErrorContext,
  platform?: string
): void {
  if (queue.length >= MAX_QUEUE) return;
  queue.push({
    message: scrub(message || 'Unknown error', 500),
    source: scrub(source || '', 200),
    stack: scrub(stack || '', 2000),
    context,
    platform: platform?.slice(0, 30),
  });
}

async function isDiagnosticsEnabled(): Promise<boolean> {
  try {
    const result = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
    return result[STORAGE_KEYS.SETTINGS]?.diagnosticsEnabled !== false;
  } catch {
    return false;
  }
}

export async function flushErrors(): Promise<void> {
  if (queue.length === 0) return;
  if (!(await isDiagnosticsEnabled())) {
    queue = [];
    return;
  }

  const batch = queue.slice(0, 5);
  const version = browser.runtime.getManifest().version;
  const browserName = navigator.userAgent.includes('Firefox') ? 'Firefox' : 'Chrome';
  const match = navigator.userAgent.match(new RegExp(browserName + '/([\\d]+)'));
  const browserStr = match ? `${browserName} ${match[1]}` : browserName;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(ERROR_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        errors: batch,
        extensionVersion: version,
        browser: browserStr,
      }),
    });
    if (res.ok) {
      queue.splice(0, batch.length);
    }
  } catch {
    // retry on next flush
  } finally {
    clearTimeout(timeout);
  }
}

export function initErrorReporter(): void {
  if (flushTimer) return;
  flushTimer = setInterval(flushErrors, FLUSH_INTERVAL_MS);
}

export function stopErrorReporter(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}
