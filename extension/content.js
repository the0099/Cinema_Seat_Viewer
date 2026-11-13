// Content scripts can't be ES modules, so this only loads the real overlay module.
(async () => {
  try {
    const mod = await import(chrome.runtime.getURL('overlay.js'));
    mod.start();
  } catch (err) {
    console.warn('[Seat View 3D] could not start:', err);
  }
})();
