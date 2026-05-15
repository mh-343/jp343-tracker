(function() {
  var lastHref = '';

  function extract() {
    var watchId = location.href.match(/\/watch\/(\d+)/);
    watchId = watchId ? watchId[1] : null;
    if (!watchId) return;
    try {
      var vp = window.netflix && window.netflix.appContext &&
        window.netflix.appContext.state && window.netflix.appContext.state.playerApp &&
        window.netflix.appContext.state.playerApp.getState() &&
        window.netflix.appContext.state.playerApp.getState().videoPlayer;
      var meta = vp && vp.videoMetadata && watchId ? vp.videoMetadata[watchId] : null;
      var video = meta && meta._video && meta._video._video ? meta._video._video : null;
      var info = video && video.id
        ? { seriesId: String(video.id), title: video.title || null, type: video.type || null }
        : null;
      document.documentElement.dataset.jp343SeriesInfo = JSON.stringify(info);
    } catch(e) {
      document.documentElement.dataset.jp343SeriesInfo = 'null';
    }
  }

  setInterval(function() {
    var href = location.href;
    if (href !== lastHref) {
      lastHref = href;
      extract();
    }
  }, 500);

  extract();
})();
