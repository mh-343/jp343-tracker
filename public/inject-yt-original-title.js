(function() {
  var targetId = 'movie_player';
  if (window.location.pathname.startsWith('/shorts')) targetId = 'shorts-player';

  var player = document.getElementById(targetId);
  var title = null;
  var videoId = null;
  var audioLang = null;
  var desc = null;
  var author = null;

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
    if (!desc) {
      desc = (response.videoDetails && response.videoDetails.shortDescription) || null;
    }
    if (!author) {
      author = (response.videoDetails && response.videoDetails.author) || null;
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

  // A response left from the previous video carries its old videoDetails.videoId,
  // so accept player data only when it matches the URL-derived id.
  if (player && typeof player.getPlayerResponse === 'function') {
    try {
      var resp = player.getPlayerResponse();
      var respId = resp && resp.videoDetails && resp.videoDetails.videoId;
      if (resp && videoId && respId === videoId) readResponse(resp);
    } catch(e) {}
  }

  // Some mobile builds lack the #movie_player API. The page still exposes the
  // player data as a global. Use it only when it matches the current video, so
  // a stale response left from a previous in-app navigation cannot leak in.
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
    detail: {
      title: title,
      videoId: videoId,
      audioLang: audioLang,
      desc: desc ? String(desc).slice(0, 800) : null,
      author: author
    }
  }));

  var me = document.currentScript;
  if (me && me.parentNode) me.parentNode.removeChild(me);
})();
