// Runs in <head> before first paint so the saved theme never flashes.
(function () {
  var root = document.documentElement;
  root.classList.remove('no-js');
  try {
    var t = localStorage.getItem('theme');
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked */ }
})();
