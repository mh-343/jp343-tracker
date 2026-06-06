(function() {
  var me = document.currentScript;
  function cleanup() { if (me && me.parentNode) me.parentNode.removeChild(me); }

  var login = null;
  try {
    var m = window.location.pathname.match(/^\/([a-zA-Z0-9_]+)/);
    login = m ? m[1] : null;
  } catch (e) {}

  function fire(detail) {
    try { window.dispatchEvent(new CustomEvent('jp343-twitch-meta', { detail: detail })); } catch (e) {}
    cleanup();
  }

  if (!login) { fire({ login: null, isLive: false }); return; }

  var query = '{ user(login:"' + login + '"){ displayName profileImageURL(width:70) stream { id type previewImageURL(width:320,height:180) } broadcastSettings { language title } } }';

  fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: query })
  })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var u = d && d.data && d.data.user;
      if (!u) { fire({ login: login, isLive: false }); return; }
      var bs = u.broadcastSettings || {};
      var stream = u.stream || null;
      var thumbnail = (stream && stream.previewImageURL) || u.profileImageURL || '';
      fire({
        login: login,
        channelName: u.displayName || login,
        language: (bs.language || '').toLowerCase(),
        title: bs.title || '',
        isLive: !!(stream && stream.type === 'live'),
        thumbnail: thumbnail
      });
    })
    .catch(function() { fire({ login: login, isLive: false }); });
})();
