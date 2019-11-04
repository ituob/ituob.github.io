// Detects Electron environment and returns the requested module, or nothing.

(function () {
  window.getElectronModule = function (moduleName) {
    if (!window.require) {
      return;
    }

    let mod;
    try {
      mod = require('electron')[moduleName];
    } catch (e) {
      return;
    }

    if (!mod) {
      return;
    }

    return mod;
  };
}());


// This module makes it so that if the page is loaded within Electron environment
// (as part of built-in app help), then external links open in user’s regular web browser.
//
// Does so by hijacking each external link’s click action,
// passing its href to `electron.shell.openExternal()` function
// instead of navigating to the URL in the same window.

(function () {
  let shell = window.getElectronModule('shell');
  if (!shell) { return; }

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


// This module sets header color to matching system chrome color.

(function () {
  let remote = window.getElectronModule('remote');
  if (!remote) { return; }

  let header = document.querySelector('body > header');
  let color = remote.systemPreferences.getColor('under-page-background');
  if (color) {
    header.style.background = color;
  }
}());
