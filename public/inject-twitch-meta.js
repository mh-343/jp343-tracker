(function() {
  var me = document.currentScript;
  function cleanup() { if (me && me.parentNode) me.parentNode.removeChild(me); }

  function post(query) {
    return fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query })
    }).then(function(r) { return r.json(); });
  }

  function fire(detail) {
    try { window.dispatchEvent(new CustomEvent('jp343-twitch-meta', { detail: detail })); } catch (e) {}
    cleanup();
  }

  var path = window.location.pathname;

  var vodMatch = path.match(/^\/videos\/(\d+)/);
  if (vodMatch) {
    var vodId = vodMatch[1];
    var vq = '{ video(id:"' + vodId + '"){ title language previewThumbnailURL owner { login displayName profileImageURL(width:150) } } }';
    post(vq)
      .then(function(d) {
        var v = d && d.data && d.data.video;
        var owner = v && v.owner;
        if (!v || !owner || !owner.login) { fire({ login: null, isVod: true, vodId: vodId, isLive: false }); return; }
        var thumb = v.previewThumbnailURL || '';
        if (thumb.indexOf('{width}') !== -1) {
          thumb = thumb.replace('{width}', '320').replace('{height}', '180');
        }
        // Unprocessed VODs return a placeholder image
        if (/\/_404\/|404_processing|404_preview/i.test(thumb)) {
          thumb = '';
        }
        fire({
          login: owner.login,
          channelName: owner.displayName || owner.login,
          language: (v.language || '').toLowerCase(),
          title: v.title || '',
          isLive: false,
          isVod: true,
          vodId: vodId,
          thumbnail: thumb || owner.profileImageURL || ''
        });
      })
      .catch(function() { fire({ login: null, isVod: true, vodId: vodId, isLive: false }); });
    return;
  }

  var login = null;
  try {
    var m = path.match(/^\/([a-zA-Z0-9_]+)/);
    login = m ? m[1] : null;
  } catch (e) {}

  if (!login) { fire({ login: null, isLive: false, isVod: false }); return; }

  var query = '{ user(login:"' + login + '"){ displayName profileImageURL(width:150) stream { id type } broadcastSettings { language title } } }';

  post(query)
    .then(function(d) {
      var u = d && d.data && d.data.user;
      if (!u) { fire({ login: login, isLive: false, isVod: false }); return; }
      var bs = u.broadcastSettings || {};
      var stream = u.stream || null;
      var thumbnail = u.profileImageURL || '';
      fire({
        login: login,
        channelName: u.displayName || login,
        language: (bs.language || '').toLowerCase(),
        title: bs.title || '',
        isLive: !!(stream && stream.type === 'live'),
        isVod: false,
        thumbnail: thumbnail
      });
    })
    .catch(function() { fire({ login: login, isLive: false, isVod: false }); });
})();
