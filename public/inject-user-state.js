(function() {
  function writeState() {
    if (window.JP343_USER) {
      document.documentElement.setAttribute('data-jp343-user', JSON.stringify({
        isLoggedIn: window.JP343_USER.isLoggedIn || false,
        userId: window.JP343_USER.userId || null,
        nonce: window.JP343_USER.nonce || null,
        ajaxUrl: window.JP343_USER.ajaxUrl || null,
        extApiToken: window.JP343_USER.extApiToken || null,
        displayName: window.JP343_USER.displayName || null,
        avatarUrlSmall: window.JP343_USER.avatarUrlSmall || null
      }));
    }
  }
  writeState();

  window.addEventListener('jp343:avatar:updated', function(e) {
    if (window.JP343_USER) {
      window.JP343_USER.avatarUrlSmall = (e.detail && e.detail.avatar_url_small) || null;
      writeState();
    }
  });
  window.addEventListener('jp343:avatar:deleted', function() {
    if (window.JP343_USER) {
      window.JP343_USER.avatarUrlSmall = null;
      writeState();
    }
  });
})();
