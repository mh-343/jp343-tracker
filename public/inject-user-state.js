// Runs in page context (not the isolated content script context).
// Reads window.JP343_USER and writes it as a data attribute on <html>
// so the content script can access it.
(function() {
  if (window.JP343_USER) {
    document.documentElement.setAttribute('data-jp343-user', JSON.stringify({
      isLoggedIn: window.JP343_USER.isLoggedIn || false,
      userId: window.JP343_USER.userId || null,
      nonce: window.JP343_USER.nonce || null,
      ajaxUrl: window.JP343_USER.ajaxUrl || null,
      guestToken: localStorage.getItem('jp343_guest_token') || null,
      extApiToken: window.JP343_USER.extApiToken || null
    }));
  }
})();
