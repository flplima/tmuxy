#!/usr/bin/env node
/**
 * Axis-B latency-injection proxy.
 *
 * Sits between the browser and a real `tmuxy server`, adding configurable
 * one-way delay + jitter (and optional loss-as-retransmit-stall) to the two
 * hot transport paths — `POST /commands` (client→server input) and the
 * `GET /events` SSE stream (server→client state). Everything else (HTML, JS,
 * wasm, /api/*) is proxied transparently with no delay so app boot stays fast,
 * unless --all is given.
 *
 * This is what makes Axis-B numbers comparable: drive the app through the proxy
 * with the PerfHud open (?perf) or read `window.__tmuxyLatency.getSnapshot()`,
 * and you get the input→paint distribution under a KNOWN synthetic RTT — the
 * controlled experiment for "how much would a faster/roaming transport buy us"
 * that the v86/wasm harness (network removed) structurally cannot run.
 *
 * Note: over TCP, real packet loss surfaces to the app as delay (head-of-line
 * retransmit), not as dropped events — so --loss models a random extra stall,
 * it does not truly drop bytes (which would only exercise the resync path).
 *
 * Usage:
 *   node scripts/latency-proxy.mjs [--target http://localhost:9000] [--port 9500]
 *       [--delay 60] [--jitter 20] [--loss 0] [--loss-stall 400] [--all]
 *
 * Then open http://localhost:9500/?perf in the browser.
 */

import http from 'node:http';

function parseArgs(argv) {
  const opts = {
    target: 'http://localhost:9000',
    port: 9500,
    delay: 60,
    jitter: 20,
    loss: 0,
    lossStall: 400,
    all: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--target') opts.target = next();
    else if (a === '--port') opts.port = Number(next());
    else if (a === '--delay') opts.delay = Number(next());
    else if (a === '--jitter') opts.jitter = Number(next());
    else if (a === '--loss') opts.loss = Number(next());
    else if (a === '--loss-stall') opts.lossStall = Number(next());
    else if (a === '--all') opts.all = true;
    else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const target = new URL(opts.target);

/** One-way delay for a single message, in ms (never negative). */
function oneWayDelay() {
  let d = opts.delay + (Math.random() * 2 - 1) * opts.jitter;
  if (opts.loss > 0 && Math.random() < opts.loss) d += opts.lossStall;
  return Math.max(0, d);
}

const isHot = (url) => url.startsWith('/commands') || url.startsWith('/events');

function proxy(clientReq, clientRes) {
  const url = clientReq.url || '/';
  const delayThisPath = opts.all || isHot(url);
  const sse = url.startsWith('/events');

  const forward = (bodyChunks) => {
    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        method: clientReq.method,
        path: url,
        headers: { ...clientReq.headers, host: target.host },
      },
      (upRes) => {
        clientRes.writeHead(upRes.statusCode || 502, upRes.headers);
        if (sse && delayThisPath) {
          // Delay each SSE chunk without reordering: a monotonic release clock
          // keeps events in order while still injecting per-event latency.
          let releaseAt = 0;
          upRes.on('data', (chunk) => {
            const at = Math.max(Date.now() + oneWayDelay(), releaseAt + 1);
            releaseAt = at;
            setTimeout(() => clientRes.write(chunk), Math.max(0, at - Date.now()));
          });
          upRes.on('end', () =>
            setTimeout(() => clientRes.end(), Math.max(0, releaseAt - Date.now())),
          );
        } else if (delayThisPath) {
          const chunks = [];
          upRes.on('data', (c) => chunks.push(c));
          upRes.on('end', () =>
            setTimeout(() => clientRes.end(Buffer.concat(chunks)), oneWayDelay()),
          );
        } else {
          upRes.pipe(clientRes);
        }
      },
    );
    upstream.on('error', (e) => {
      if (!clientRes.headersSent) clientRes.writeHead(502);
      clientRes.end(`latency-proxy upstream error: ${e.message}`);
    });
    for (const c of bodyChunks) upstream.write(c);
    upstream.end();
  };

  // Buffer the (tiny) request body, then apply inbound delay before forwarding.
  const body = [];
  clientReq.on('data', (c) => body.push(c));
  clientReq.on('end', () => {
    if (delayThisPath && !sse) setTimeout(() => forward(body), oneWayDelay());
    else forward(body);
  });
}

http.createServer(proxy).listen(opts.port, () => {
  const rtt = `${(opts.delay * 2).toFixed(0)}ms base RTT ±${(opts.jitter * 2).toFixed(0)}ms`;
  console.log(`latency-proxy → ${opts.target}`);
  console.log(`  listening on http://localhost:${opts.port}  (open /?perf)`);
  console.log(
    `  injecting ${rtt}${opts.loss > 0 ? `, loss ${opts.loss} → +${opts.lossStall}ms stall` : ''} on ${
      opts.all ? 'ALL paths' : '/commands + /events'
    }`,
  );
});
