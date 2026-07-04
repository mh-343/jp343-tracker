import { parseTitleLevel } from '../../lib/difficulty-seeds';
import type { DifficultySeed } from '../../lib/difficulty-seeds';
import {
  getCardTitleText,
  getChannelIdFromElement,
  getChannelNameFromElement,
  extractVideoIdFromElement
} from '../../lib/youtube-utils';

export type ChannelSeedLookup =
  (channelId: string | null, channelName: string | null) => DifficultySeed | null;

const BADGE_CLASS = 'jp343-fb-badge';
const BADGE_ATTR = 'data-jp343-fb';
const STYLE_ID = 'jp343-fb-styles';
const SWEEP_DEBOUNCE_MS = 150;

const BADGE_CARD_SELECTORS = [
  'ytd-rich-item-renderer',
  'ytd-video-renderer',
  'ytd-compact-video-renderer',
  'ytd-grid-video-renderer',
  'yt-lockup-view-model',
  'ytd-playlist-video-renderer',
  'ytd-movie-renderer'
].join(',');

// pending user console verification
const ANCHOR_SELECTORS = [
  'ytd-channel-name',
  '#metadata-line',
  '.yt-lockup-metadata-view-model-wiz__metadata',
  'yt-content-metadata-view-model'
];

let activeLookup: ChannelSeedLookup | null = null;
let feedObserver: MutationObserver | null = null;
let sweepTimer: ReturnType<typeof setTimeout> | null = null;

function injectStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .${BADGE_CLASS} {
      display: inline-flex;
      align-items: center;
      margin: 2px 0 2px 6px;
      padding: 0 6px;
      border-radius: 6px;
      background: rgba(12, 12, 20, 0.85);
      border: 1px solid rgba(255, 0, 128, 0.25);
      font-size: 11px;
      line-height: 18px;
      font-family: 'Roboto', -apple-system, sans-serif;
      white-space: nowrap;
      vertical-align: middle;
      user-select: none;
    }
    .${BADGE_CLASS} .jp343-fb-level {
      color: #ff4fa3;
      font-weight: 600;
    }
    .${BADGE_CLASS} .jp343-fb-mixed {
      color: #f0b429;
      font-weight: 600;
    }
  `;
  doc.head.appendChild(style);
}

function formatBadgeText(seed: DifficultySeed): string {
  if (seed.mixed) {
    return seed.jlptHint ? `Mixed ${seed.jlptHint}` : `Mixed ~L${seed.level}`;
  }
  return seed.jlptHint ? `L${seed.level} ${seed.jlptHint}` : `L${seed.level}`;
}

function buildBadge(seed: DifficultySeed): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.className = BADGE_CLASS;
  badge.title = 'jp343 difficulty (beta)';
  const inner = document.createElement('span');
  inner.className = seed.mixed ? 'jp343-fb-mixed' : 'jp343-fb-level';
  inner.textContent = formatBadgeText(seed);
  badge.appendChild(inner);
  return badge;
}

function findAnchor(card: Element): Element | null {
  for (const selector of ANCHOR_SELECTORS) {
    const el = card.querySelector(selector);
    if (el) return el;
  }
  return null;
}

function removeBadge(card: Element): void {
  card.querySelector('.' + BADGE_CLASS)?.remove();
  card.removeAttribute(BADGE_ATTR);
}

export function lookupSeedInMap(
  map: Record<string, DifficultySeed> | null,
  channelId: string | null,
  channelName: string | null
): DifficultySeed | null {
  if (!map) return null;
  for (const key of [channelId, channelName]) {
    if (!key) continue;
    const entry = map[key.trim().toLowerCase()];
    if (entry) return entry;
  }
  return null;
}

function sweepCard(card: Element, lookup: ChannelSeedLookup): void {
  if (card.querySelector(BADGE_CARD_SELECTORS)) return;
  if (!card.querySelector('a[href*="/watch?v="]')) { removeBadge(card); return; }
  const videoId = extractVideoIdFromElement(card);
  if (!videoId) { removeBadge(card); return; }

  const title = getCardTitleText(card);
  const fromTitle = title ? parseTitleLevel(title) : null;
  const seed = fromTitle || lookup(getChannelIdFromElement(card), getChannelNameFromElement(card));
  if (!seed) { removeBadge(card); return; }

  const desiredText = formatBadgeText(seed);
  const existing = card.querySelector('.' + BADGE_CLASS);
  if (existing && card.getAttribute(BADGE_ATTR) === videoId && existing.textContent === desiredText) {
    return;
  }

  existing?.remove();
  const anchor = findAnchor(card);
  if (!anchor) { card.removeAttribute(BADGE_ATTR); return; }
  anchor.insertAdjacentElement('afterend', buildBadge(seed));
  card.setAttribute(BADGE_ATTR, videoId);
}

function sweep(): void {
  const lookup = activeLookup;
  if (!lookup) return;
  document.querySelectorAll(BADGE_CARD_SELECTORS).forEach(card => sweepCard(card, lookup));
}

export function scheduleFeedBadgeSweep(): void {
  if (!activeLookup) return;
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = setTimeout(() => { sweepTimer = null; sweep(); }, SWEEP_DEBOUNCE_MS);
}

export function startFeedBadges(lookup: ChannelSeedLookup): void {
  activeLookup = lookup;
  injectStyles(document);
  if (!feedObserver) {
    feedObserver = new MutationObserver((mutations) => {
      const hasNewCard = mutations.some(mutation =>
        Array.from(mutation.addedNodes).some(node =>
          node instanceof Element
          && (node.matches(BADGE_CARD_SELECTORS) || !!node.querySelector(BADGE_CARD_SELECTORS))));
      if (hasNewCard) scheduleFeedBadgeSweep();
    });
    feedObserver.observe(document.body, { childList: true, subtree: true });
  }
  scheduleFeedBadgeSweep();
}

export function removeAllFeedBadges(): void {
  document.querySelectorAll('.' + BADGE_CLASS).forEach(el => el.remove());
  document.querySelectorAll('[' + BADGE_ATTR + ']').forEach(el => el.removeAttribute(BADGE_ATTR));
}

export function stopFeedBadges(): void {
  feedObserver?.disconnect();
  feedObserver = null;
  if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = null; }
  removeAllFeedBadges();
  activeLookup = null;
}
