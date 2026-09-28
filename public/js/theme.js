// Runs before first paint: apply the saved day/night choice (default follows the system).
(function () {
  try {
    var saved = localStorage.getItem('nf-theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
  } catch (e) {
    /* storage blocked — follow the system */
  }
})();
