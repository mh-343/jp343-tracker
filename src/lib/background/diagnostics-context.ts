import type { Platform, ExtensionDiagnostics } from '../../types';
import type { DiagnosticsExport } from '../diagnostics';

export interface DiagnosticsContext {
  recordDiagnosticEvent: (code: string, platform?: Platform) => void;
  getDiagnostics: () => Promise<ExtensionDiagnostics>;
  buildExportReport: (diagnostics: ExtensionDiagnostics) => DiagnosticsExport;
}
