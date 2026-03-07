// =============================================================================
// JP343 Extension - YouTube Ad Simulation Script
// Zum Testen der Ad-Erkennung ohne echte Werbung
//
// Nutzung:
//   1. YouTube-Video abspielen
//   2. DevTools oeffnen (F12)
//   3. Dieses Script in die Console einfuegen
//   4. Befehle nutzen:
//      - JP343_startAd()     → Simuliert YouTube-Werbung
//      - JP343_stopAd()      → Beendet die Simulation
//      - JP343_adCycle(ms)   → Kompletter Zyklus (Standard: 10s)
//      - JP343_adStatus()    → Zeigt welche Ad-Selektoren gefunden werden
// =============================================================================

(function() {
  'use strict';

  // Verhindere doppeltes Laden
  if (window._jp343SimLoaded) {
    console.log('[JP343 SIM] Bereits geladen. Befehle: JP343_startAd(), JP343_stopAd(), JP343_adCycle(ms), JP343_adStatus()');
    return;
  }
  window._jp343SimLoaded = true;

  let cycleTimeout = null;

  // =========================================================================
  // JP343_startAd() - Simuliert YouTube-Werbung
  // =========================================================================
  window.JP343_startAd = function() {
    const player = document.querySelector('#movie_player');
    if (!player) {
      console.error('[JP343 SIM] #movie_player nicht gefunden! Bist du auf einer YouTube Watch-Seite?');
      return;
    }

    // Pruefen ob bereits simuliert
    if (player.classList.contains('ad-showing') && document.querySelector('[data-jp343-simulated]')) {
      console.warn('[JP343 SIM] Simulation laeuft bereits. Nutze JP343_stopAd() zum Beenden.');
      return;
    }

    console.log('[JP343 SIM] === STARTE AD-SIMULATION ===');

    // 1. ad-showing Klasse auf #movie_player setzen
    player.classList.add('ad-showing');

    // 2. Fake Ad-Overlay erstellen
    const overlay = document.createElement('div');
    overlay.className = 'ytp-ad-player-overlay';
    overlay.setAttribute('data-jp343-simulated', 'true');
    overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:1000;pointer-events:none;';
    player.appendChild(overlay);

    // 3. Fake Ad-Text
    const adText = document.createElement('div');
    adText.className = 'ytp-ad-text';
    adText.setAttribute('data-jp343-simulated', 'true');
    adText.style.cssText = 'position:absolute;bottom:60px;left:12px;color:#fff;font-size:12px;z-index:1001;background:rgba(0,0,0,0.7);padding:4px 8px;border-radius:2px;';
    adText.textContent = '[SIMULATED] Werbung wird nach dem Video abgespielt';
    player.appendChild(adText);

    // 4. Fake Ad-Preview-Container
    const preview = document.createElement('div');
    preview.className = 'ytp-ad-preview-container';
    preview.setAttribute('data-jp343-simulated', 'true');
    preview.style.cssText = 'position:absolute;bottom:60px;right:12px;color:#fff;font-size:12px;z-index:1001;background:rgba(0,0,0,0.7);padding:4px 8px;border-radius:2px;';
    preview.textContent = '[SIMULATED] Werbung · 0:15';
    player.appendChild(preview);

    // 5. Fake Skip-Button (klickbar)
    const skipBtn = document.createElement('button');
    skipBtn.className = 'ytp-ad-skip-button';
    skipBtn.setAttribute('data-jp343-simulated', 'true');
    skipBtn.style.cssText = 'position:absolute;bottom:80px;right:12px;color:#fff;font-size:14px;z-index:1002;background:rgba(0,0,0,0.8);padding:8px 16px;border:1px solid #fff;border-radius:4px;cursor:pointer;pointer-events:auto;';
    skipBtn.textContent = 'Werbung ueberspringen ▶';
    skipBtn.addEventListener('click', function() {
      console.log('[JP343 SIM] Skip-Button geklickt');
      window.JP343_stopAd();
    });
    player.appendChild(skipBtn);

    // 6. Fake Instream-Info
    const instreamInfo = document.createElement('div');
    instreamInfo.className = 'ytp-ad-player-overlay-instream-info';
    instreamInfo.setAttribute('data-jp343-simulated', 'true');
    instreamInfo.style.cssText = 'position:absolute;top:12px;left:12px;color:#ff0;font-size:11px;z-index:1001;background:rgba(0,0,0,0.7);padding:4px 8px;border-radius:2px;';
    instreamInfo.textContent = '[JP343 SIMULATED AD]';
    player.appendChild(instreamInfo);

    console.log('[JP343 SIM] Ad-Simulation aktiv. Nutze JP343_stopAd() oder klicke den Skip-Button.');
  };

  // =========================================================================
  // JP343_stopAd() - Beendet die Simulation
  // =========================================================================
  window.JP343_stopAd = function() {
    const player = document.querySelector('#movie_player');
    if (!player) {
      console.error('[JP343 SIM] #movie_player nicht gefunden!');
      return;
    }

    // Timeout abbrechen falls adCycle laeuft
    if (cycleTimeout) {
      clearTimeout(cycleTimeout);
      cycleTimeout = null;
    }

    // ad-showing Klasse entfernen
    player.classList.remove('ad-showing');

    // Alle simulierten Elemente entfernen
    const simulated = document.querySelectorAll('[data-jp343-simulated="true"]');
    let removed = 0;
    simulated.forEach(function(el) {
      el.remove();
      removed++;
    });

    console.log('[JP343 SIM] === AD-SIMULATION BEENDET === (' + removed + ' Elemente entfernt)');
  };

  // =========================================================================
  // JP343_adCycle(ms) - Kompletter Zyklus
  // =========================================================================
  window.JP343_adCycle = function(durationMs) {
    const duration = durationMs || 10000;
    console.log('[JP343 SIM] Starte Ad-Zyklus fuer ' + (duration / 1000) + ' Sekunden');

    window.JP343_startAd();

    cycleTimeout = setTimeout(function() {
      window.JP343_stopAd();
      cycleTimeout = null;
      console.log('[JP343 SIM] Ad-Zyklus abgeschlossen');
    }, duration);
  };

  // =========================================================================
  // JP343_adStatus() - Zeigt welche Ad-Selektoren gefunden werden
  // =========================================================================
  window.JP343_adStatus = function() {
    const selectors = {
      '.ytp-ad-player-overlay': '.ytp-ad-player-overlay',
      '.ytp-ad-player-overlay-instream-info': '.ytp-ad-player-overlay-instream-info',
      '.ytp-ad-text': '.ytp-ad-text',
      '.ytp-ad-skip-button': '.ytp-ad-skip-button',
      '.ytp-ad-skip-button-container': '.ytp-ad-skip-button-container',
      '.ad-showing': '.ad-showing',
      '.ytp-ad-preview-container': '.ytp-ad-preview-container',
      '[class*="ad-interrupting"]': '[class*="ad-interrupting"]',
      '#movie_player.ad-showing': '#movie_player.ad-showing'
    };

    console.log('[JP343 SIM] === AD-SELECTOR STATUS ===');

    let anyFound = false;
    for (const [name, selector] of Object.entries(selectors)) {
      const el = document.querySelector(selector);
      if (el) {
        const isSimulated = el.hasAttribute('data-jp343-simulated') ||
          (el.id === 'movie_player' && el.querySelector('[data-jp343-simulated]'));
        const type = isSimulated ? 'SIMULATED' : 'REAL';
        console.log('  ✓ ' + name + ' → GEFUNDEN (' + type + ')');
        anyFound = true;
      } else {
        console.log('  ✗ ' + name + ' → nicht gefunden');
      }
    }

    // Zusammenfassung
    const player = document.querySelector('#movie_player');
    const hasAdShowing = player ? player.classList.contains('ad-showing') : false;
    const simulatedCount = document.querySelectorAll('[data-jp343-simulated]').length;

    console.log('');
    console.log('[JP343 SIM] Zusammenfassung:');
    console.log('  #movie_player vorhanden: ' + !!player);
    console.log('  ad-showing Klasse aktiv: ' + hasAdShowing);
    console.log('  Simulierte Elemente: ' + simulatedCount);
    console.log('  Ad erkannt: ' + anyFound);

    return {
      adDetected: anyFound,
      hasAdShowing: hasAdShowing,
      simulatedElements: simulatedCount
    };
  };

  // =========================================================================
  // Startup
  // =========================================================================
  console.log('[JP343 SIM] YouTube Ad-Simulation geladen.');
  console.log('[JP343 SIM] Befehle:');
  console.log('  JP343_startAd()      → Simuliert YouTube-Werbung');
  console.log('  JP343_stopAd()       → Beendet die Simulation');
  console.log('  JP343_adCycle(ms)    → Kompletter Zyklus (Standard: 10s)');
  console.log('  JP343_adStatus()     → Zeigt welche Ad-Selektoren gefunden werden');
})();
