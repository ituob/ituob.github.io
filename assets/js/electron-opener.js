// This module makes it so that if the page is loaded within Electron environment
// (as part of built-in app help), then external links open in user’s regular web browser.
//
// It does so by detecting Electron environment (bailing if not detected),
// and hijacking each external link’s click action,
// passing its href to `electron.shell.openExternal()` function
// instead of navigating to the URL in the same window.

(function () {
  if (!window.require) {
    return;
  }

  let shell;
  try {
    shell = require('electron').shell;
  } catch (e) {
    return;
  }

  if (!shell) {
    return;
  }

  Array.from(document.querySelectorAll('a')).forEach(a => {
    if (a.hostname.length > 0 && location.hostname !== a.hostname) {
      a.addEventListener('click', function (evt) {
        shell.openExternal(a.getAttribute('href'));

        evt.preventDefault();
        evt.stopPropagation();
        return true;
      });
    }
  });
}());
