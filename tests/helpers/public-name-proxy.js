/**
 * A reverse proxy that publishes a tmuxy server under a public name.
 *
 * What a real one (portless, nginx, Caddy) does to a request and nothing more:
 * forward it with the public name as its `Host`, and the page's origin with it.
 * The browser still talks to localhost, so no name has to resolve — the server
 * is what sees the public name, and the server is what is under test.
 */

const http = require('http');

/** Start the proxy; resolves to `{ url, stop }`. */
function startPublicNameProxy({ listenPort, targetPort, publicName }) {
  const proxy = http.createServer((req, res) => {
    const headers = { ...req.headers, host: publicName };
    if (headers.origin) headers.origin = `http://${publicName}`;
    const upstream = http.request(
      { host: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => res.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  return new Promise((resolve, reject) => {
    proxy.on('error', reject);
    proxy.listen(listenPort, '127.0.0.1', () =>
      resolve({
        url: `http://localhost:${listenPort}`,
        stop: () => {
          proxy.closeAllConnections();
          proxy.close();
        },
      }),
    );
  });
}

module.exports = { startPublicNameProxy };
