(function() {
  window.addEventListener('jp343:requestSeriesInfo', function() {
    try {
      var watchId = location.href.match(/\/watch\/(\d+)/);
      watchId = watchId ? watchId[1] : null;
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
  });
})();
