import type { MpchcSnapshot } from '../mpchc';
import { MPCHC_ORIGINS } from '../mpchc';

function decodeFile(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
    if (code[0] !== '#') return named[code.toLowerCase()] ?? entity;
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : entity;
  });
}

export function parseMpchcVariables(html: string): MpchcSnapshot {
  const fields: Record<string, string> = {};
  const pattern = /<p\b[^>]*\bid\s*=\s*["'](file|state|position|duration)["'][^>]*>([\s\S]*?)<\/p\s*>/gi;
  for (const match of html.matchAll(pattern)) fields[match[1].toLowerCase()] = match[2];
  if (!/^(-1|[012])$/.test(fields.state?.trim() ?? '') || !/^\d+$/.test(fields.position?.trim() ?? '') || fields.file === undefined) {
    throw new Error('Invalid player response');
  }
  const position = Number(fields.position);
  if (!Number.isSafeInteger(position)) throw new Error('Invalid player position');
  // duration is optional, 0 means unknown
  const rawDuration = fields.duration?.trim() ?? '';
  const duration = /^\d+$/.test(rawDuration) && Number.isSafeInteger(Number(rawDuration)) ? Number(rawDuration) : 0;
  return { file: decodeFile(fields.file), state: Number(fields.state) as -1 | 0 | 1 | 2, position, duration };
}

export async function readMpchc(): Promise<{ snapshot: MpchcSnapshot | null; status: 'unreachable' | 'error' }> {
  let status: 'unreachable' | 'error' = 'unreachable';
  for (const origin of MPCHC_ORIGINS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(origin.replace('*', 'variables.html'), {
        signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
      });
      if (!response.ok) throw new Error('Player request failed');
      return { snapshot: parseMpchcVariables(await response.text()), status };
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof Error && error.name === 'AbortError')) status = 'error';
    } finally {
      clearTimeout(timer);
    }
  }
  return { snapshot: null, status };
}
