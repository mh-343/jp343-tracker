// Dieses Script laeuft im Page Context (nicht im isolierten Content Script Context)
// Es liest window.JP343_USER und schreibt es als data-Attribut auf <html>
// So kann das Content Script die Daten lesen
// Guest Token wird aus localStorage gelesen (falls Gast mit Token-Session)
(function() {
  if (window.JP343_USER) {
    document.documentElement.setAttribute('data-jp343-user', JSON.stringify({
      isLoggedIn: window.JP343_USER.isLoggedIn || false,
      userId: window.JP343_USER.userId || null,
      nonce: window.JP343_USER.nonce || null,
      ajaxUrl: window.JP343_USER.ajaxUrl || null,
      guestToken: localStorage.getItem('jp343_guest_token') || null
    }));
  }
})();
