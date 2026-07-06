(function() {
  var me = document.currentScript;
  if (me && me.parentNode) me.parentNode.removeChild(me);

  var eventName = 'jp343-yt-captions';
  var videoId = null;
  try {
    var path = window.location.pathname;
    if (path.startsWith('/shorts/')) {
      var m = path.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
      videoId = m ? m[1] : null;
    } else {
      videoId = new URLSearchParams(window.location.search).get('v') || null;
    }
  } catch(e) {}

  function fire(detail) {
    detail.videoId = videoId;
    window.dispatchEvent(new CustomEvent(eventName, { detail: detail }));
  }

  if (!videoId) { fire({ baseUrl: null }); return; }

  var apiKey, hl, gl;
  try {
    var cfg = window.yt && window.yt.config_;
    apiKey = cfg && cfg.INNERTUBE_API_KEY;
    hl = (cfg && cfg.HL) || 'en';
    gl = (cfg && cfg.GL) || 'US';
  } catch(e) {}
  if (!apiKey) { fire({ baseUrl: null }); return; }

  // iOS client: its caption URLs are not PoToken-gated (WEB ones are).
  var iosContext = {
    client: {
      clientName: 'IOS', clientVersion: '20.30.2',
      deviceMake: 'Apple', deviceModel: 'iPhone16,2',
      osName: 'iOS', osVersion: '18.1.0.22B83',
      hl: hl, gl: gl
    }
  };

  fetch('/youtubei/v1/player?key=' + apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: iosContext, videoId: videoId, contentCheckOk: true, racyCheckOk: true })
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    var baseUrl = null, lang = null, kind = null, lengthSeconds = null;
    if (d && d.videoDetails && d.videoDetails.lengthSeconds) {
      var n = parseInt(d.videoDetails.lengthSeconds, 10);
      lengthSeconds = isNaN(n) ? null : n;
    }
    var tl = d && d.captions && d.captions.playerCaptionsTracklistRenderer;
    var tracks = tl && tl.captionTracks;
    if (Array.isArray(tracks) && tracks.length) {
      var pick = tracks.filter(function(t){ return t && t.languageCode === 'ja' && t.kind !== 'asr'; })[0]
              || tracks.filter(function(t){ return t && t.languageCode === 'ja'; })[0];
      if (pick) { baseUrl = pick.baseUrl || null; lang = pick.languageCode || null; kind = pick.kind || null; }
    }
    fire({ baseUrl: baseUrl, languageCode: lang, kind: kind, lengthSeconds: lengthSeconds });
  })
  .catch(function() { fire({ baseUrl: null }); });
})();
