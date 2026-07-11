import { getMokuroReinjectTarget } from './mokuro-sync';

type Logger = (...args: unknown[]) => void;

interface ReinjectTarget {
  matches: string[];
  file: string;
  extraFiles?: string[];
  allFrames?: boolean;
}

const TARGETS: ReinjectTarget[] = [
  {
    matches: ['*://*.netflix.com/*'],
    file: 'content-scripts/netflix.js'
  },
  {
    matches: ['*://*.youtube.com/*'],
    file: 'content-scripts/youtube.js',
    extraFiles: [
      'content-scripts/youtube-titles.js',
      'content-scripts/youtube-filter.js'
    ]
  },
  {
    matches: ['*://*.twitch.tv/*'],
    file: 'content-scripts/twitch.js'
  },
  {
    matches: ['*://*.crunchyroll.com/*'],
    file: 'content-scripts/crunchyroll.js',
    allFrames: true
  },
  {
    matches: ['*://*.disneyplus.com/*'],
    file: 'content-scripts/disneyplus.js'
  },
  {
    matches: [
      '*://*.primevideo.com/*',
      '*://*.amazon.com/*',
      '*://*.amazon.de/*',
      '*://*.amazon.co.jp/*',
      '*://*.amazon.com.br/*'
    ],
    file: 'content-scripts/primevideo.js'
  },
  {
    matches: ['*://open.spotify.com/*'],
    file: 'content-scripts/spotify.js'
  },
  {
    matches: ['*://app.asbplayer.dev/*'],
    file: 'content-scripts/asbplayer.js'
  },
  {
    matches: ['*://*.cijapanese.com/*', '*://*.nijapanese.com/*'],
    file: 'content-scripts/cijapanese.js'
  },
  {
    matches: ['*://*.nihongo-jikan.com/*'],
    file: 'content-scripts/nihongojikan.js',
    allFrames: true
  }
];

const PROBE_TIMEOUT_MS = 500;

// No listener = dead/orphaned tab.
function isDeadTab(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Receiving end does not exist');
}

// Did a live instance answer the probe?
async function tabHasLiveInstance(tabId: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      browser.tabs.sendMessage(tabId, { type: 'GET_CONTENT_TIME' }),
      timeout
    ]);
    return true;
  } catch (err) {
    if (isDeadTab(err)) return false;
    return true;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function reinjectTab(tabId: number, target: ReinjectTarget): Promise<void> {
  const allFrames = target.allFrames ?? false;
  await browser.scripting.executeScript({
    target: { tabId, allFrames },
    func: () => {
      try {
        (window as unknown as { __jp343Claimed?: unknown }).__jp343Claimed = {};
        document.querySelectorAll('[data-jp343-tracked]')
          .forEach(el => el.removeAttribute('data-jp343-tracked'));
      } catch { /* page locked down */ }
    }
  });
  await browser.scripting.executeScript({
    target: { tabId, allFrames },
    files: [target.file, ...(target.extraFiles ?? [])]
  });
}

// After an update, re-inject trackers
// into open tabs so tracking resumes
// without a manual reload.
async function reinjectTarget(target: ReinjectTarget, log: Logger): Promise<void> {
  try {
    const tabs = await browser.tabs.query({ url: target.matches });
    await Promise.all(tabs.map(async (tab) => {
      const tabId = tab.id;
      if (typeof tabId !== 'number') return;
      try {
        if (await tabHasLiveInstance(tabId)) return;
        await reinjectTab(tabId, target);
        log('[JP343] reinject: resumed', target.file, tabId);
      } catch (err) {
        log('[JP343] reinject: tab failed', target.file, tabId, err);
      }
    }));
  } catch (err) {
    log('[JP343] reinject: target failed', target.file, err);
  }
}

export async function reinjectTrackedTabs(log: Logger): Promise<void> {
  if (import.meta.env.MANIFEST_VERSION !== 3 || !browser.scripting?.executeScript) return;

  const targets = [...TARGETS];
  const mokuro = await getMokuroReinjectTarget();
  if (mokuro) targets.push(mokuro);

  for (const target of targets) {
    await reinjectTarget(target, log);
  }
}

// Re-inject only the Mokuro tabs
export async function reinjectMokuroTabs(log: Logger): Promise<void> {
  if (import.meta.env.MANIFEST_VERSION !== 3 || !browser.scripting?.executeScript) return;
  const mokuro = await getMokuroReinjectTarget();
  if (mokuro) await reinjectTarget(mokuro, log);
}
