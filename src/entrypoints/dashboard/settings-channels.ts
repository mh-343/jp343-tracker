import type { ExtensionSettings, BlockedChannel } from '../../types';

function buildBlockedPanel(container: HTMLElement, settings: ExtensionSettings): void {
  const card = document.createElement('div');
  card.className = 'card';

  const header = document.createElement('div');
  header.className = 'blocked-header';
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = 'Blocked Channels';
  title.style.marginBottom = '0';
  const count = document.createElement('span');
  count.className = 'blocked-count';
  count.id = 'settingsBlockedCount';
  count.textContent = `${settings.blockedChannels.length} blocked`;
  header.appendChild(title);
  header.appendChild(count);
  card.appendChild(header);

  const channels = settings.blockedChannels;

  if (channels.length >= 5) {
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'blocked-search';
    search.placeholder = 'Filter channels...';
    search.addEventListener('input', () => {
      renderBlockedList(list, channels, search.value);
    });
    card.appendChild(search);
  }

  const list = document.createElement('div');
  list.id = 'settingsBlockedList';
  renderBlockedList(list, channels, '');
  card.appendChild(list);

  container.appendChild(card);
}

function renderBlockedList(listEl: HTMLElement, channels: BlockedChannel[], filter: string): void {
  listEl.textContent = '';

  const filtered = filter
    ? channels.filter(c => c.channelName.toLowerCase().includes(filter.toLowerCase()))
    : channels;

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'blocked-empty';
    empty.textContent = channels.length === 0 ? 'No blocked channels' : 'No matches';
    listEl.appendChild(empty);
    return;
  }

  for (const channel of filtered) {
    listEl.appendChild(createBlockedRow(channel, channels));
  }
}

function createBlockedRow(channel: BlockedChannel, allChannels: BlockedChannel[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'blocked-row';

  const name = document.createElement('span');
  name.className = 'blocked-channel-name';
  name.textContent = channel.channelName;
  name.title = channel.channelName;

  const badge = document.createElement('span');
  badge.className = 'blocked-platform-badge';
  badge.textContent = getPlatformFromChannelId(channel.channelId);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'blocked-unblock-btn';
  btn.textContent = 'Unblock';
  btn.addEventListener('click', async () => {
    await browser.runtime.sendMessage({ type: 'UNBLOCK_CHANNEL', channelId: channel.channelId });
    const idx = allChannels.findIndex(c => c.channelId === channel.channelId);
    if (idx !== -1) allChannels.splice(idx, 1);
    row.remove();
    const countEl = document.getElementById('settingsBlockedCount');
    if (countEl) countEl.textContent = `${allChannels.length} blocked`;
  });

  row.appendChild(name);
  row.appendChild(badge);
  row.appendChild(btn);
  return row;
}

function getPlatformFromChannelId(channelId: string): string {
  if (channelId.startsWith('spotify:')) return 'spotify';
  if (channelId.startsWith('netflix:')) return 'netflix';
  if (channelId.startsWith('crunchyroll:')) return 'crunchyroll';
  if (channelId.startsWith('primevideo:')) return 'primevideo';
  if (channelId.startsWith('disneyplus:')) return 'disneyplus';
  return 'youtube';
}

function buildWhitelistedPanel(container: HTMLElement, settings: ExtensionSettings): void {
  const card = document.createElement('div');
  card.className = 'card';

  const header = document.createElement('div');
  header.className = 'blocked-header';
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = 'Allowed Channels';
  title.style.marginBottom = '0';
  const count = document.createElement('span');
  count.className = 'blocked-count';
  count.id = 'settingsWhitelistedCount';
  count.textContent = `${settings.whitelistedChannels.length} allowed`;
  header.appendChild(title);
  header.appendChild(count);
  card.appendChild(header);

  const channels = settings.whitelistedChannels;
  const list = document.createElement('div');
  list.id = 'settingsWhitelistedList';

  if (channels.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'blocked-empty';
    empty.textContent = 'No allowed channels';
    list.appendChild(empty);
  } else {
    for (const channel of channels) {
      const row = document.createElement('div');
      row.className = 'blocked-row';
      const name = document.createElement('span');
      name.className = 'blocked-channel-name';
      name.textContent = channel.channelName;
      name.title = channel.channelName;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'blocked-unblock-btn';
      btn.textContent = 'Remove';
      btn.addEventListener('click', async () => {
        await browser.runtime.sendMessage({ type: 'UNWHITELIST_CHANNEL', channelId: channel.channelId });
        const idx = channels.findIndex(c => c.channelId === channel.channelId);
        if (idx !== -1) channels.splice(idx, 1);
        row.remove();
        const countEl = document.getElementById('settingsWhitelistedCount');
        if (countEl) countEl.textContent = `${channels.length} allowed`;
      });
      row.appendChild(name);
      row.appendChild(btn);
      list.appendChild(row);
    }
  }

  card.appendChild(list);
  container.appendChild(card);
}

export function rebuildChannelsPanel(grid: HTMLElement, settings: ExtensionSettings): void {
  grid.textContent = '';
  const blockedCol = document.createElement('div');
  blockedCol.className = 'channels-col';
  buildBlockedPanel(blockedCol, settings);
  const allowedCol = document.createElement('div');
  allowedCol.className = 'channels-col';
  buildWhitelistedPanel(allowedCol, settings);
  grid.appendChild(blockedCol);
  grid.appendChild(allowedCol);
}
