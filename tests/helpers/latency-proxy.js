/**
 * A reverse proxy that puts a slow link between the browser and a tmuxy server.
 *
 * What the app does over a link is two things: `POST` a command and read the
 * `GET /events` stream. Each is held for half the round trip in its direction,
 * a POST on the way up and again on the way down, the stream chunk by chunk,
 * so a key's echo costs one round trip, as it does over a real link of that
 * RTT. Order is kept within a connection: what is delayed is released in the
 * order it came, never by racing timers. Requests on different connections
 * are independent, as they are on a network, so two POSTs can still reach
 * the server reversed. The page's own files pass straight through: they are
 * loaded once, and waiting for them measures nothing.
 */

const http = require('http');

/** Runs what it is handed `ms` later, in the order it was handed. */
function delayLine(ms) {
  const queue = [];
  let timer = null;
  const drain = () => {
    timer = null;
    while (queue.length > 0 && queue[0].due <= Date.now()) queue.shift().run();
    if (queue.length > 0) timer = setTimeout(drain, Math.max(0, queue[0].due - Date.now()));
  };
  return {
    push(run) {
      queue.push({ due: Date.now() + ms, run });
      if (timer === null) timer = setTimeout(drain, ms);
    },
    clear() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      queue.length = 0;
    },
  };
}

const crossesTheLink = (req) => req.method === 'POST' || req.url.split('?')[0] === '/events';

/**
 * Start the proxy in front of the server on `targetPort`, adding `rttMs` to
 * every round trip; resolves to `{ url, port, stop }`. `listenPort` 0 takes
 * any free port.
 */
function startLatencyProxy({ targetPort, rttMs, listenPort = 0 }) {
  const oneWay = rttMs / 2;
  const proxy = http.createServer((req, res) => {
    const slow = crossesTheLink(req);
    const up = delayLine(slow ? oneWay : 0);
    const down = delayLine(slow ? oneWay : 0);
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (response) => {
        down.push(() => {
          res.writeHead(response.statusCode, response.headers);
          // An event stream is read as it comes: its headers must not sit in
          // a buffer until the first event.
          res.flushHeaders();
        });
        response.on('data', (chunk) => down.push(() => res.write(chunk)));
        response.on('end', () => down.push(() => res.end()));
      },
    );
    upstream.on('error', () => res.destroy());
    res.on('close', () => {
      up.clear();
      down.clear();
      upstream.destroy();
    });
    req.on('data', (chunk) => up.push(() => upstream.write(chunk)));
    req.on('end', () => up.push(() => upstream.end()));
  });
  return new Promise((resolve, reject) => {
    proxy.on('error', reject);
    proxy.listen(listenPort, '127.0.0.1', () => {
      const { port } = proxy.address();
      resolve({
        url: `http://localhost:${port}`,
        port,
        stop: () => {
          proxy.closeAllConnections();
          proxy.close();
        },
      });
    });
  });
}

module.exports = { startLatencyProxy };
