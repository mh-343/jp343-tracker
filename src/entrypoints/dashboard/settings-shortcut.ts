const SHORTCUTS_URL = 'chrome://extensions/shortcuts';

interface ShortcutInfo {
  command: string;
  label: string;
  desc: string;
}

const SHORTCUTS: ShortcutInfo[] = [
  { command: 'toggle-tracking', label: 'Start or stop tracking', desc: 'Start a manual session for this page, or stop and save the running one.' },
  { command: 'toggle-pause', label: 'Pause or resume tracking', desc: 'Temporarily halt or continue the active session.' }
];

const kbdByCommand = new Map<string, HTMLElement>();
let listenerBound = false;

async function refresh(): Promise<void> {
  let shortcutByName = new Map<string, string>();
  try {
    const commands = await browser.commands.getAll();
    shortcutByName = new Map(commands.map((c): [string, string] => [c.name ?? '', (c.shortcut ?? '').trim()]));
  } catch { /* ignore */ }

  for (const [command, kbd] of kbdByCommand) {
    const shortcut = shortcutByName.get(command) || '';
    kbd.textContent = shortcut || 'Not set';
    kbd.classList.toggle('shortcut-key-set', !!shortcut);
  }
}

export function buildShortcutPanel(container: HTMLElement): void {
  kbdByCommand.clear();

  const section = document.createElement('div');
  section.className = 'settings-section';

  const title = document.createElement('div');
  title.className = 'settings-section-title';
  title.textContent = 'Keyboard shortcuts';
  section.appendChild(title);

  const help = document.createElement('div');
  help.className = 'settings-row-desc';
  help.textContent = 'Control tracking with hotkeys, without opening the popup. Useful for pages the extension does not track automatically.';
  section.appendChild(help);

  for (const item of SHORTCUTS) {
    const row = document.createElement('div');
    row.className = 'settings-row';

    const info = document.createElement('div');
    info.className = 'settings-row-info';
    const label = document.createElement('div');
    label.className = 'settings-row-label';
    label.textContent = item.label;
    const desc = document.createElement('div');
    desc.className = 'settings-row-desc';
    desc.textContent = item.desc;
    info.appendChild(label);
    info.appendChild(desc);
    row.appendChild(info);

    const kbd = document.createElement('span');
    kbd.className = 'shortcut-key';
    kbd.textContent = 'Not set';
    row.appendChild(kbd);
    kbdByCommand.set(item.command, kbd);

    section.appendChild(row);
  }

  const footer = document.createElement('div');
  footer.className = 'shortcut-footer';
  if (navigator.userAgent.includes('Firefox')) {
    const hint = document.createElement('span');
    hint.className = 'shortcut-hint';
    hint.textContent = 'Set these in about:addons, gear icon, Manage Extension Shortcuts.';
    footer.appendChild(hint);
  } else {
    const setBtn = document.createElement('button');
    setBtn.type = 'button';
    setBtn.className = 'export-btn';
    setBtn.textContent = 'Set shortcuts';
    setBtn.addEventListener('click', () => {
      browser.tabs.create({ url: SHORTCUTS_URL }).catch(() => {});
    });
    footer.appendChild(setBtn);
  }
  section.appendChild(footer);

  container.appendChild(section);

  void refresh();

  if (!listenerBound) {
    listenerBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void refresh();
    });
  }
}
