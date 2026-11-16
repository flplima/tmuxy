#!/usr/bin/env node
// The only road from the Claude review's fenced user to the Claude API.
//
// Runs as the runner user, which the fence keeps the agent out of, on
// 127.0.0.1. It reads the subscription token from stdin, so it is in no
// environment, and puts it on every request it forwards to api.anthropic.com.
// Claude Code talks to it as an LLM gateway with a placeholder token: neither
// it nor any command it runs ever holds the real one. Only the endpoints a
// review needs are forwarded, so the token cannot reach anything else of the
// account; a request that brings its own key loses it here.
//
//   printf %s "$TOKEN" | node claude-api-proxy.mjs <port>
import http from 'node:http';
import https from 'node:https';

const UPSTREAM = 'api.anthropic.com';
const OAUTH_BETA = 'oauth-2025-04-20';
export const ALLOWED = [
  ['POST', /^\/v1\/messages(?:\?.*)?$/],
  ['POST', /^\/v1\/messages\/count_tokens(?:\?.*)?$/],
];
const DROPPED = new Set(['host', 'authorization', 'x-api-key', 'connection', 'content-length']);

export function allowed(method, url) {
  return ALLOWED.some(([m, re]) => m === method && re.test(url));
}

export function upstreamHeaders(headers, token) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!DROPPED.has(name.toLowerCase())) out[name] = value;
  }
  const betas = String(out['anthropic-beta'] ?? '')
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);
  if (!betas.includes(OAUTH_BETA)) betas.push(OAUTH_BETA);
  out['anthropic-beta'] = betas.join(',');
  out.authorization = `Bearer ${token}`;
  return out;
}

async function readToken() {
  let token = '';
  for await (const chunk of process.stdin) token += chunk;
  token = token.trim();
  if (!token) throw new Error('no token on stdin');
  return token;
}

function serve(token, port) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200).end('ok');
      return;
    }
    if (!allowed(req.method, req.url)) {
      console.log(`refused ${req.method} ${req.url.split('?')[0]}`);
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"permission_error","message":"not forwarded"}}');
      return;
    }
    const upstream = https.request(
      {
        host: UPSTREAM,
        path: req.url,
        method: req.method,
        headers: upstreamHeaders(req.headers, token),
      },
      (up) => {
        console.log(`${req.method} ${req.url.split('?')[0]} -> ${up.statusCode}`);
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      console.log(`upstream error: ${err.code ?? err.message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  server.listen(port, '127.0.0.1', () => console.log(`claude-api-proxy on 127.0.0.1:${port}`));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2]);
  if (!Number.isInteger(port)) throw new Error('usage: claude-api-proxy.mjs <port>');
  serve(await readToken(), port);
}
