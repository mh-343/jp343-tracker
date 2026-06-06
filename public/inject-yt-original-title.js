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

  if (player && typeof player.getPlayerResponse === 'function') {
    try {
      var response = player.getPlayerResponse();
      title = (response && response.videoDetails && response.videoDetails.title) || null;
      var tl = response && response.captions && response.captions.playerCaptionsTracklistRenderer;
      var tracks = tl && tl.captionTracks;
      if (tracks && tracks.length) {
        var asr = tracks.filter(function(t){ return t && t.kind === 'asr'; })[0];
        audioLang = (asr && asr.languageCode) || null;
      }
    } catch(e) {}
  }

  window.dispatchEvent(new CustomEvent('jp343-original-title', {
    detail: { title: title, videoId: videoId, audioLang: audioLang }
  }));

  var me = document.currentScript;
  if (me && me.parentNode) me.parentNode.removeChild(me);
})();
