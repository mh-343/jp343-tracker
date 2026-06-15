(function() {
  var targetId = 'movie_player';
  if (window.location.pathname.startsWith('/shorts')) targetId = 'shorts-player';

  var player = document.getElementById(targetId);
  var title = null;
  var videoId = null;
  var audioLang = null;

  try {
    var path = window.location.pathname;
    if (path.startsWith('/shorts/')) {
      var m = path.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
      videoId = m ? m[1] : null;
    } else {
      videoId = new URLSearchParams(window.location.search).get('v') || null;
    }
  } catch(e) {}

  function readResponse(response) {
    if (!response) return;
    if (!title) {
      title = (response.videoDetails && response.videoDetails.title) || null;
    }
    if (!audioLang) {
      var tl = response.captions && response.captions.playerCaptionsTracklistRenderer;
      var tracks = tl && tl.captionTracks;
      if (Array.isArray(tracks) && tracks.length) {
        var asr = tracks.filter(function(t){ return t && t.kind === 'asr'; })[0];
        audioLang = (asr && asr.languageCode) || null;
      }
    }
  }

  if (player && typeof player.getPlayerResponse === 'function') {
    try { readResponse(player.getPlayerResponse()); } catch(e) {}
  }

  // Mobile has no #movie_player API. The page still exposes the player data as a
  // global. Use it only when it matches the current video, so a stale response
  // left from a previous in-app navigation cannot leak in.
  if (!title || !audioLang) {
    try {
      var global = window.ytInitialPlayerResponse;
      var globalId = global && global.videoDetails && global.videoDetails.videoId;
      if (global && videoId && globalId === videoId) {
        readResponse(global);
      }
    } catch(e) {}
  }

  window.dispatchEvent(new CustomEvent('jp343-original-title', {
    detail: { title: title, videoId: videoId, audioLang: audioLang }
  }));

  var me = document.currentScript;
  if (me && me.parentNode) me.parentNode.removeChild(me);
})();
