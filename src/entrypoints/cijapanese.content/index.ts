import { createCijTracker } from '../../lib/cij-tracker';
import { claimContentScript } from '../../lib/content-guard';

export default defineContentScript({
  matches: ['*://*.cijapanese.com/*', '*://*.nijapanese.com/*'],
  runAt: 'document_idle',

  main() {
    if (!claimContentScript('cijapanese')) return;
    createCijTracker({
      platform: 'cijapanese',
      channelId: 'cijapanese',
      channelName: 'CI Japanese',
      channelUrl: 'https://cijapanese.com',
      loggerKey: 'cijapanese',
      fallbackTitle: 'CI Japanese Content',
      titleStripPatterns: [
        /\s*[|–-]\s*Comprehensible Japanese.*$/i,
        /\s*[|–-]\s*CI Japanese.*$/i,
        /\s*[|–-]\s*Natural Japanese.*$/i
      ]
    });
  }
});
