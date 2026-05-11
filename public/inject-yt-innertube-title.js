(function() {
  var me = document.currentScript;
  if (me && me.parentNode) me.parentNode.removeChild(me);

  var videoId = null;
  var eventName = 'jp343-innertube-title';

  try {
    var path = window.location.pathname;
    if (path.startsWith('/shorts/')) {
      var m = path.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
      videoId = m ? m[1] : null;
    } else {
      videoId = new URLSearchParams(window.location.search).get('v') || null;
    }
  } catch(e) {}

  function fire(title) {
    window.dispatchEvent(new CustomEvent(eventName, { detail: { title: title, videoId: videoId } }));
  }

  if (!videoId) { fire(null); return; }

  var apiKey, ctx;
  try {
    apiKey = window.yt && window.yt.config_ && window.yt.config_.INNERTUBE_API_KEY;
    ctx = window.ytcfg && typeof window.ytcfg.get === 'function' && window.ytcfg.get('INNERTUBE_CONTEXT');
  } catch(e) {}

  if (!apiKey || !ctx) { fire(null); return; }

  fetch('/youtubei/v1/player?key=' + apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoId: videoId, context: ctx })
  })
  .then(function(r) { return r.json(); })
  .then(function(d) { fire((d && d.videoDetails && d.videoDetails.title) || null); })
  .catch(function() { fire(null); });

})();
