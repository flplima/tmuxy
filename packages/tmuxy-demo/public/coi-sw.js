// Cross-origin isolation for a host that cannot send headers (GitHub Pages).
// The CheerpX guest needs SharedArrayBuffer, which a page has only when it is
// served with COOP and COEP; this worker adds them to every response from the
// site's own origin. Cross-origin requests pass through untouched: what the
// page loads from elsewhere (the CheerpX runtime, analytics) already sends
// Cross-Origin-Resource-Policy, which COEP asks of it.
// Registered by coi-register.js in app/layout.tsx.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.status === 0) return response;
        const headers = new Headers(response.headers);
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      })
      .catch(() => fetch(request)),
  );
});
