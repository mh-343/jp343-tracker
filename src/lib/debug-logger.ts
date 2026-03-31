export const DEBUG_MODE = import.meta.env.DEV;

export interface DebugLogger {
  log: (...args: unknown[]) => void;
  debugLog: (category: string, message: string, data?: Record<string, unknown>) => void;
  getBuffer: () => string[];
  clearBuffer: () => void;
}

export function createDebugLogger(platform: string): DebugLogger {
  const log = DEBUG_MODE ? console.log.bind(console) : (..._args: unknown[]) => {};
  const buffer: string[] = [];
  const MAX_ENTRIES = 5000;

  function debugLog(category: string, message: string, data?: Record<string, unknown>): void {
    if (!DEBUG_MODE) return;
    const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);
    const fullTimestamp = new Date().toISOString();
    const logLine = `[${fullTimestamp}] [${category}] ${message}`;
    console.log(`[JP343 DEBUG ${timestamp}] [${category}]`, message, data || '');
    const bufferEntry = data ? `${logLine} ${JSON.stringify(data)}` : logLine;
    buffer.push(bufferEntry);
    if (buffer.length > MAX_ENTRIES) buffer.shift();
  }

  return { log, debugLog, getBuffer: () => buffer, clearBuffer: () => { buffer.length = 0; } };
}

export function downloadBuffer(buffer: string[], platform: string): void {
  const content = buffer.join('\n');
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `jp343-${platform}-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.log`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  console.log('[JP343] Log file downloaded with', buffer.length, 'entries');
}

export function setupDebugCommands(logger: DebugLogger, platform: string, options?: { logStatus?: boolean }): void {
  if (!DEBUG_MODE) return;
  const hasLogStatus = options?.logStatus !== false;

  const script = document.createElement('script');
  script.textContent = `
    window.JP343_downloadLogs = function() {
      window.dispatchEvent(new CustomEvent('JP343_REQUEST_LOGS'));
    };
    window.JP343_clearLogs = function() {
      window.dispatchEvent(new CustomEvent('JP343_CLEAR_LOGS'));
    };
    ${hasLogStatus ? `window.JP343_logStatus = function() {
      window.dispatchEvent(new CustomEvent('JP343_LOG_STATUS'));
    };` : ''}
    console.log('[JP343] Debug active. Commands: JP343_downloadLogs(), JP343_clearLogs()${hasLogStatus ? ', JP343_logStatus()' : ''}');
  `;
  (document.head || document.documentElement).appendChild(script);
  script.remove();

  window.addEventListener('JP343_REQUEST_LOGS', () => downloadBuffer(logger.getBuffer(), platform));
  window.addEventListener('JP343_CLEAR_LOGS', () => {
    logger.clearBuffer();
    console.log('[JP343] Log buffer cleared');
  });
  if (hasLogStatus) {
    window.addEventListener('JP343_LOG_STATUS', () => {
      console.log('[JP343] Log buffer:', logger.getBuffer().length, 'entries');
    });
  }
}
