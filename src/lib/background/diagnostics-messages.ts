import type { ExtensionMessage, Platform } from '../../types';
import type { DiagnosticsContext } from './diagnostics-context';
import { readSyncQueue, readSyncPending } from './sync-queue';
import { hasSyncIssue } from '../sync-policy';

type DiagnosticsMessage = Extract<ExtensionMessage, { type: 'DIAGNOSTIC_EVENT' | 'GET_DIAGNOSTICS' }>;

export function handleDiagnosticsMessage(
  message: DiagnosticsMessage,
  context: DiagnosticsContext
): Promise<unknown> {
  switch (message.type) {
    case 'DIAGNOSTIC_EVENT':
      return handleDiagnosticEvent(message.code, message.platform, context);
    case 'GET_DIAGNOSTICS':
      return handleGetDiagnostics(context);
    default:
      return Promise.resolve({ success: false, error: 'Unknown diagnostics message' });
  }
}

async function handleDiagnosticEvent(
  code: string,
  platform: Platform | undefined,
  context: DiagnosticsContext
): Promise<{ success: true }> {
  context.recordDiagnosticEvent(code, platform);
  return { success: true };
}

async function handleGetDiagnostics(
  context: DiagnosticsContext
): Promise<{ success: true; data: unknown }> {
  const diagnostics = await context.getDiagnostics();
  const report = context.buildExportReport(diagnostics);
  const queue = await readSyncQueue();
  const entries = await readSyncPending();
  return { success: true, data: { ...report, syncQueue: {
    counters: queue.counts,
    pending: entries.filter(e => !e.synced).length,
    issues: entries.filter(hasSyncIssue).length,
    blocked: entries.filter(e => !e.synced && e.syncState?.status === 'blocked').length
  } } };
}
