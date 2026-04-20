import type { VideoState, SpotifyContentType } from '../../types';
import { createDebugLogger, setupDebugCommands } from '../../lib/debug-logger';

export default defineContentScript({
  matches: ['*://open.spotify.com/*'],
  runAt: 'document_idle',

  main() {
    const observers: MutationObserver[] = [];
    const intervalIds: ReturnType<typeof setInterval>[] = [];
    function cleanup(): void {
      observers.forEach(o => o.disconnect());
      intervalIds.forEach(clearInterval);
      observers.length = 0;
      intervalIds.length = 0;
    }
    window.addEventListener('pagehide', () => {
      if (wasPlaying) {
        sendMessage('VIDEO_ENDED');
      }
      cleanup();
    });
    window.addEventListener('beforeunload', () => {
      if (wasPlaying) {
        sendMessage('VIDEO_ENDED');
      }
    });

    const logger = createDebugLogger('spotify');
    const { log, debugLog } = logger;
    log('[JP343] Spotify Content Script loaded');

    setupDebugCommands(logger, 'spotify', { logStatus: true });

    const isIncognito = browser.extension?.inIncognitoContext ?? false;
    function sendDiagnostic(code: string): void {
      if (isIncognito) return;
      try {
        browser.runtime.sendMessage({ type: 'DIAGNOSTIC_EVENT', code, platform: 'spotify' }).catch(() => {});
      } catch { /* best-effort */ }
    }
    sendDiagnostic('content_script_loaded');
    setTimeout(() => {
      const hasPlayer = !!document.querySelector('[data-testid="control-button-playpause"]');
      sendDiagnostic(hasPlayer ? 'player_found' : 'player_missing');
    }, 15000);

    let wasPlaying = false;
    let lastTrackTitle = '';
    let lastTrackHref = '';
    let isCurrentlyInAd = false;
    let metadataMissingReported = false;

    function isPlaying(): boolean {
      const btn = document.querySelector('[data-testid="control-button-playpause"]');
      if (!btn) return false;
      const label = btn.getAttribute('aria-label') || '';
      return label.toLowerCase().includes('pause');
    }

    function getContextLink(): HTMLAnchorElement | null {
      const bar = document.querySelector('[data-testid="now-playing-widget"]');
      if (!bar) return null;
      return bar.querySelector('[data-testid="context-item-link"]') as HTMLAnchorElement | null;
    }

    function getArtistLink(): HTMLAnchorElement | null {
      const bar = document.querySelector('[data-testid="now-playing-widget"]');
      if (!bar) return null;
      return bar.querySelector('[data-testid="context-item-info-subtitles"] a[href*="/artist/"]') as HTMLAnchorElement
        || bar.querySelector('[data-testid="context-item-info-subtitles"] a[href*="/show/"]') as HTMLAnchorElement
        || bar.querySelector('[data-testid="context-item-info-artist"] a') as HTMLAnchorElement
        || null;
    }

    function getCoverArt(): string | null {
      const bar = document.querySelector('[data-testid="now-playing-widget"]');
      if (!bar) return null;
      const img = bar.querySelector('[data-testid="cover-art-image"]') as HTMLImageElement | null;
      return img?.src || null;
    }

    function detectContentType(href: string): SpotifyContentType {
      if (href.includes('/episode/')) return 'podcast';
      if (href.includes('/chapter/') || href.includes('/audiobook/')) return 'audiobook';
      return 'music';
    }

    function getTrackTitle(): string {
      const bar = document.querySelector('[data-testid="now-playing-widget"]');
      if (!bar) return '';
      const titleEl = bar.querySelector('[data-testid="context-item-info-title"]');
      return titleEl?.textContent?.trim() || '';
    }

    function getArtistOrShowName(): string {
      const bar = document.querySelector('[data-testid="now-playing-widget"]');
      if (bar) {
        const artistEl = bar.querySelector('[data-testid="context-item-info-subtitles"]');
        const text = artistEl?.textContent?.trim();
        if (text) return text;
      }
      const docTitle = document.title;
      const match = docTitle.match(/^.+?\s[-\u2013]\s(.+?)(?:\s[-\u2013|]\s*Spotify.*)?$/i);
      if (match?.[1]) return match[1].trim();
      return '';
    }

    function parseTimeString(timeStr: string): number {
      const parts = timeStr.split(':').map(Number);
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      return 0;
    }

    function getPlaybackTimes(): { currentTime: number; duration: number } {
      const posEl = document.querySelector('[data-testid="playback-position"]');
      const durEl = document.querySelector('[data-testid="playback-duration"]');
      return {
        currentTime: posEl ? parseTimeString(posEl.textContent || '0:00') : 0,
        duration: durEl ? parseTimeString(durEl.textContent || '0:00') : 0
      };
    }

    function isAdPlaying(): boolean {
      return !!document.querySelector('[data-testid="context-item-info-ad-subtitle"]');
    }

    function getChannelId(contentType: SpotifyContentType): string | null {
      const link = getArtistLink();
      if (!link) return null;
      const href = (link as HTMLAnchorElement).getAttribute?.('href') || '';
      if (contentType === 'podcast') {
        const match = href.match(/\/show\/([a-zA-Z0-9]+)/);
        return match ? `spotify:show:${match[1]}` : null;
      }
      const match = href.match(/\/artist\/([a-zA-Z0-9]+)/);
      return match ? `spotify:artist:${match[1]}` : null;
    }

    function getChannelUrl(): string | null {
      const link = getArtistLink();
      if (!link) return null;
      const href = (link as HTMLAnchorElement).getAttribute?.('href') || '';
      if (!href) return null;
      if (href.startsWith('/')) return `https://open.spotify.com${href}`;
      return href;
    }

    function getCurrentState(): VideoState | null {
      const contextLink = getContextLink();
      const trackHref = contextLink?.getAttribute('href') || '';
      if (!trackHref) return null;

      const title = getTrackTitle();
      if (!title) return null;

      const artistName = getArtistOrShowName();
      const contentType = detectContentType(trackHref);
      const { currentTime, duration } = getPlaybackTimes();
      const fullUrl = trackHref.startsWith('/') ? `https://open.spotify.com${trackHref}` : trackHref;
      const idMatch = trackHref.match(/\/(track|episode|chapter)\/([a-zA-Z0-9]+)/);

      const displayTitle = artistName ? `${title} - ${artistName}` : title;

      return {
        isPlaying: isPlaying(),
        currentTime,
        duration,
        title: displayTitle,
        url: fullUrl,
        platform: 'spotify',
        isAd: isCurrentlyInAd,
        thumbnailUrl: getCoverArt(),
        videoId: idMatch ? idMatch[2] : null,
        channelId: getChannelId(contentType),
        channelName: artistName || null,
        channelUrl: getChannelUrl(),
        contentType
      };
    }

    async function sendMessage(type: string, data?: Record<string, unknown>): Promise<void> {
      try {
        await browser.runtime.sendMessage({
          type,
          platform: 'spotify',
          ...data
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes('Extension context invalidated')) return;
        log('[JP343] Message error:', error);
      }
    }

    function handlePlayStateChange(): void {
      const playing = isPlaying();
      const adPlaying = isAdPlaying();

      if (adPlaying && !isCurrentlyInAd) {
        isCurrentlyInAd = true;
        log('[JP343] Spotify: Ad started');
        sendMessage('AD_START');
        return;
      }
      if (!adPlaying && isCurrentlyInAd) {
        isCurrentlyInAd = false;
        log('[JP343] Spotify: Ad ended');
        sendMessage('AD_END');
      }

      if (isCurrentlyInAd) return;

      const contextLink = getContextLink();
      const trackHref = contextLink?.getAttribute('href') || '';
      const trackTitle = getTrackTitle();

      if (playing && trackHref && trackHref !== lastTrackHref && lastTrackHref) {
        log('[JP343] Spotify: Track changed:', lastTrackTitle, '->', trackTitle);
        sendMessage('VIDEO_ENDED');
        lastTrackHref = trackHref;
        lastTrackTitle = trackTitle;
        const state = getCurrentState();
        if (state) {
          sendMessage('VIDEO_PLAY', { state });
        }
        wasPlaying = true;
        return;
      }

      if (playing && !wasPlaying) {
        const state = getCurrentState();
        if (state) {
          lastTrackHref = trackHref;
          lastTrackTitle = trackTitle;
          log('[JP343] Spotify: Play started:', state.title);
          debugLog('PLAY', 'Playback started', { title: state.title, contentType: state.contentType });
          sendMessage('VIDEO_PLAY', { state });
          sendDiagnostic('video_play_sent');
          sendDiagnostic(state.title ? 'metadata_found' : 'metadata_missing');
          wasPlaying = true;
          metadataMissingReported = false;
        } else if (!metadataMissingReported) {
          sendDiagnostic('metadata_missing');
          metadataMissingReported = true;
        }
      } else if (!playing && wasPlaying) {
        log('[JP343] Spotify: Paused');
        sendMessage('VIDEO_PAUSE');
        wasPlaying = false;
        metadataMissingReported = false;
      }
    }

    intervalIds.push(setInterval(handlePlayStateChange, 1000));

    intervalIds.push(setInterval(() => {
      if (!wasPlaying || isCurrentlyInAd) return;
      const state = getCurrentState();
      if (state && state.isPlaying) {
        sendMessage('VIDEO_STATE_UPDATE', { state });
      }
    }, 30000));

    const widget = document.querySelector('[data-testid="now-playing-widget"]');
    if (widget) {
      const widgetObserver = new MutationObserver(() => {
        if (wasPlaying) {
          handlePlayStateChange();
        }
      });
      widgetObserver.observe(widget, { childList: true, subtree: true, characterData: true });
      observers.push(widgetObserver);
      log('[JP343] Spotify: Now-playing widget observer attached');
    } else {
      const bodyObserver = new MutationObserver(() => {
        const w = document.querySelector('[data-testid="now-playing-widget"]');
        if (w) {
          bodyObserver.disconnect();
          const widgetObserver = new MutationObserver(() => {
            if (wasPlaying) {
              handlePlayStateChange();
            }
          });
          widgetObserver.observe(w, { childList: true, subtree: true, characterData: true });
          observers.push(widgetObserver);
          log('[JP343] Spotify: Now-playing widget found and observer attached');
        }
      });
      bodyObserver.observe(document.body, { childList: true, subtree: true });
      observers.push(bodyObserver);
    }

    setTimeout(() => {
      if (isPlaying() && !wasPlaying) {
        log('[JP343] Spotify: Already playing on load');
        handlePlayStateChange();
      }
    }, 2000);

    browser.runtime.onMessage.addListener((message) => {
      const btn = document.querySelector('[data-testid="control-button-playpause"]') as HTMLElement | null;
      if (!btn) return;
      if (message?.type === 'PAUSE_VIDEO' && isPlaying()) {
        btn.click();
      }
      if (message?.type === 'RESUME_VIDEO' && !isPlaying()) {
        btn.click();
      }
    });
  }
});
