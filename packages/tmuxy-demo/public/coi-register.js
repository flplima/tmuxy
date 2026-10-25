// Puts the page under coi-sw.js, the worker that makes it cross-origin
// isolated so the demo can run the CheerpX guest. A page the worker does not
// serve yet is reloaded once, after the worker is ready. Until then
// `window.__tmuxyIsolation` stays pending, so the demo does not start a guest
// the reload would throw away. It settles, and the demo starts on v86, where
// isolation cannot happen: no service workers, a failed registration, or a
// page still not isolated after the one reload this tab is allowed.
(() => {
  const KEY = 'tmuxy-isolation-reload';
  const storage = () => {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  };
  if (window.crossOriginIsolated) {
    storage()?.removeItem(KEY);
    return;
  }
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
  const sw = navigator.serviceWorker;
  // Served by the worker and still not isolated: this browser cannot be.
  if (sw.controller) return;
  const session = storage();
  if (!session || session.getItem(KEY)) return;
  window.__tmuxyIsolation = sw
    .register('/coi-sw.js')
    .then(() => sw.ready)
    .then(() => {
      session.setItem(KEY, '1');
      window.location.reload();
      return new Promise(() => {});
    })
    .catch(() => undefined);
})();
