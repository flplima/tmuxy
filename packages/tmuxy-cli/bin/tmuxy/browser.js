#!/usr/bin/env node
'use strict';
/**
 * A live browser in a tmuxy pane, over the Chrome DevTools Protocol. Run by
 * `tmuxy widget browser` (tmuxy-widget-browser); the pure mappings are in
 * browser-lib.js.
 *
 * Starts a headless Chrome (or attaches to one by its DevTools endpoint),
 * opens the page in a tab sized to the pane — every row but the last, each
 * cell DEFAULT_CELL pixels — and takes a screenshot of it `--fps` times a
 * second (DevTools' screencast stalls in a headless window once the first
 * frames are out; a screenshot never does). A frame that differs from the
 * last is written to the pane as Kitty graphics, wrapped for tmux to relay,
 * anchored at the home cell so it replaces the last one in place. The last row is a
 * status line: the page's title and address, in text, so `tmuxy pane
 * capture` still says what the pane shows.
 *
 * What the pane delivers — what the user types, what `tmuxy pane send` sends,
 * the SGR mouse reports the UI forwards while the mouse is tracked — goes to
 * the page as DevTools input: text inserted, keys pressed, clicks and wheels
 * landed on the pixel at the middle of their cell. Ctrl+Q ends the session;
 * Ctrl+C reaches the page.
 *
 * Needs node 22 (its own WebSocket) and a Chrome or Chromium; no package.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./browser-lib.js');

const USAGE = `Usage: tmuxy widget browser [options] <url>

Show a web page live in this pane, drawn as Kitty graphics from a headless
Chrome, and drive it from the pane: typing, keys (Enter, Tab, arrows, Ctrl
chords) and the mouse go to the page. Ctrl+Q ends it.

Options:
  --cdp <endpoint>   Attach to a running Chrome instead of starting one: a
                     ws:// DevTools URL, an http://host:port, or a port.
  --chrome <path>    The Chrome/Chromium to start (default: $TMUXY_CHROME,
                     then google-chrome, chromium, chromium-browser, or
                     Playwright's chromium).
  --cell WxH         Page pixels per cell (default 8x16).
  --png              Lossless frames (default: JPEG at --quality).
  --quality <1-100>  JPEG quality (default 80).
  --fps <n>          At most this many frames a second (default 15).
  -h, --help         This help.

Driving it from a script: \`tmuxy pane send -t <pane> 'hello' Enter\` types
into the page; a click is an SGR mouse report sent the same way, e.g.
\`tmuxy pane send -t <pane> -- $'\\e[<0;10;5M' $'\\e[<0;10;5m'\` presses and
releases the left button on column 10, row 5. \`tmuxy pane capture <pane>\`
reads the status line: the page's title and address.`;

function parseArgs(argv) {
  const opts = {
    cdp: null,
    chrome: process.env.TMUXY_CHROME || null,
    cell: lib.DEFAULT_CELL,
    png: false,
    quality: 80,
    fps: 15,
    url: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(2, `${a} needs a value`);
      return argv[++i];
    };
    if (a === '-h' || a === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (a === '--cdp') opts.cdp = next();
    else if (a === '--chrome') opts.chrome = next();
    else if (a === '--png') opts.png = true;
    else if (a === '--quality') opts.quality = Math.min(100, Math.max(1, Number(next()) || 80));
    else if (a === '--fps') opts.fps = Math.max(1, Number(next()) || 15);
    else if (a === '--cell') {
      const m = /^(\d+)x(\d+)$/.exec(next());
      if (!m) fail(2, '--cell takes WxH, e.g. 8x16');
      opts.cell = { width: Number(m[1]), height: Number(m[2]) };
    } else if (a === '--') {
      opts.url = argv[i + 1] ?? null;
      break;
    } else if (a.startsWith('-')) fail(2, `Unknown option: ${a}`);
    else if (opts.url === null) opts.url = a;
    else fail(2, `one url, not two: ${a}`);
  }
  if (!opts.url) fail(2, 'a url is required');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(opts.url)) opts.url = `https://${opts.url}`;
  return opts;
}

function fail(code, message) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
}

/** The first Chrome on this machine. */
function findChrome(given) {
  const candidates = given ? [given] : [];
  if (!given) {
    for (const name of [
      'google-chrome',
      'google-chrome-stable',
      'chromium',
      'chromium-browser',
      'chrome',
    ]) {
      for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        const p = path.join(dir, name);
        if (dir && fs.existsSync(p)) candidates.push(p);
      }
    }
    const pw = path.join(os.homedir(), '.cache', 'ms-playwright');
    if (fs.existsSync(pw)) {
      for (const d of fs
        .readdirSync(pw)
        .filter((n) => n.startsWith('chromium'))
        .sort()
        .reverse()) {
        for (const rel of [
          'chrome-linux/chrome',
          'chrome-linux64/chrome',
          'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        ]) {
          const p = path.join(pw, d, rel);
          if (fs.existsSync(p)) candidates.push(p);
        }
      }
    }
    for (const p of [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
    ]) {
      if (fs.existsSync(p)) candidates.push(p);
    }
  }
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found)
    fail(1, 'no Chrome found: pass --chrome <path>, set TMUXY_CHROME, or attach with --cdp');
  return found;
}

/** Start a headless Chrome; resolve its DevTools browser endpoint. */
function launchChrome(exe, viewport) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-browser-'));
  const child = spawn(
    exe,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--mute-audio',
      `--window-size=${viewport.width},${viewport.height}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const endpoint = new Promise((resolve, reject) => {
    let buf = '';
    child.stderr.on('data', (d) => {
      buf += d.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) resolve(m[1]);
    });
    child.on('exit', (code) =>
      reject(new Error(`Chrome exited (${code}) before listening:\n${buf.trim()}`)),
    );
    setTimeout(() => reject(new Error('Chrome did not start within 20s')), 20000).unref();
  });
  const stop = () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    fs.rm(profile, { recursive: true, force: true }, () => {});
  };
  return { endpoint, stop };
}

/** A browser DevTools websocket URL from what --cdp was given. */
async function resolveEndpoint(given) {
  if (/^ws:/.test(given)) return given;
  const base = /^\d+$/.test(given) ? `http://127.0.0.1:${given}` : given.replace(/\/$/, '');
  const res = await fetch(`${base}/json/version`);
  if (!res.ok) throw new Error(`${base}/json/version answered ${res.status}`);
  const json = await res.json();
  if (!json.webSocketDebuggerUrl) throw new Error(`no webSocketDebuggerUrl at ${base}`);
  return json.webSocketDebuggerUrl;
}

/** A minimal DevTools client: `send(method, params)` and `on(event, fn)`, flat sessions. */
function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const handlers = new Map();
  let id = 0;
  const open = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', (e) =>
      reject(new Error(`DevTools socket: ${e.message || 'error'}`)),
    );
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, method } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const fn of handlers.get(msg.method) || []) fn(msg.params, msg.sessionId);
    }
  });
  return {
    open,
    send(method, params = {}, sessionId) {
      const msgId = ++id;
      ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
      return new Promise((resolve, reject) => pending.set(msgId, { resolve, reject, method }));
    },
    on(method, fn) {
      if (!handlers.has(method)) handlers.set(method, []);
      handlers.get(method).push(fn);
    },
    close() {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
    closed: new Promise((resolve) => ws.addEventListener('close', resolve)),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const out = process.stdout;
  if (!out.isTTY || !process.stdin.isTTY) fail(1, 'run this inside a pane: it needs a terminal');

  const size = () => lib.viewportFor(out.columns || 80, out.rows || 24, opts.cell);
  let viewport = size();

  let chrome = null;
  let endpoint;
  if (opts.cdp) endpoint = await resolveEndpoint(opts.cdp);
  else {
    chrome = launchChrome(findChrome(opts.chrome), viewport);
    endpoint = await chrome.endpoint;
  }

  const cdp = connect(endpoint);
  await cdp.open;
  // Its own window, in front, as a page the user opened would be.
  const { targetId } = await cdp.send('Target.createTarget', {
    url: 'about:blank',
    newWindow: true,
  });
  await cdp.send('Target.activateTarget', { targetId }).catch(() => {});
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => cdp.send(method, params, sessionId);

  let title = '';
  let url = opts.url;
  const drawStatus = () => out.write(lib.statusLine(out.rows || 24, out.columns || 80, title, url));

  const applyViewport = async () => {
    await page('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  };
  // Frames: a screenshot `--fps` times a second, written only when it differs
  // from the last one, one write at a time. A screenshot asked for while a
  // navigation swaps the renderer fails; the next tick asks again.
  let lastFrame = null;
  let writing = false;
  const tick = async () => {
    if (quitting) return;
    if (!writing) {
      try {
        const { data } = await page('Page.captureScreenshot', {
          format: opts.png ? 'png' : 'jpeg',
          ...(opts.png ? {} : { quality: opts.quality }),
        });
        if (data !== lastFrame && !quitting) {
          lastFrame = data;
          writing = true;
          out.write(
            lib.kittyFrame(data, viewport.cols, viewport.rows) +
              lib.statusLine(out.rows || 24, out.columns || 80, title, url),
            () => {
              writing = false;
            },
          );
        }
      } catch {
        /* the page is between renderers; the next tick tries again */
      }
    }
    if (!quitting) setTimeout(tick, 1000 / opts.fps).unref();
  };
  cdp.on('Page.frameNavigated', (params, sid) => {
    if (sid !== sessionId || params.frame.parentId) return;
    url = params.frame.url;
    drawStatus();
  });

  // The terminal: alternate screen, no cursor, the mouse tracked, raw keys.
  out.write(lib.ENTER);
  drawStatus();
  process.stdin.setRawMode(true);
  process.stdin.resume();

  let rest = '';
  let quitting = false;
  const quit = async (code = 0) => {
    if (quitting) return;
    quitting = true;
    try {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    } finally {
      cdp.close();
      if (chrome) chrome.stop();
      process.stdin.setRawMode(false);
      out.write(lib.LEAVE, () => process.exit(code));
    }
  };

  process.stdin.on('data', (chunk) => {
    const parsed = lib.parseInput(rest + chunk.toString('utf8'));
    rest = parsed.rest;
    for (const event of parsed.events) {
      if (event.kind === 'quit') {
        quit(0);
        return;
      }
      for (const [method, params] of lib.toCdp(event, opts.cell))
        page(method, params).catch(() => {});
    }
  });
  process.on('SIGTERM', () => quit(0));
  process.on('SIGHUP', () => quit(0));
  process.stdin.on('end', () => quit(0));
  cdp.closed.then(() => {
    if (!quitting) {
      process.stderr.write('Error: the browser went away\n');
      quit(1);
    }
  });

  // The pane resized: the page follows, and the next frame is the new size.
  let resizeTimer = null;
  out.on('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      viewport = size();
      out.write(`\x1b[2J`);
      lastFrame = null;
      await applyViewport().catch(() => {});
      drawStatus();
    }, 150);
  });

  await page('Page.enable');
  // A headless window is never the focused one, and a page that believes it
  // has no focus drops what is typed into it: the focus is emulated.
  await page('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await applyViewport();
  await page('Page.navigate', { url: opts.url });
  tick();
  // The title, as it settles.
  const readTitle = async () => {
    try {
      const { result } = await page('Runtime.evaluate', {
        expression: 'document.title',
        returnByValue: true,
      });
      if (result.value !== title) {
        title = result.value || '';
        drawStatus();
      }
    } catch {
      /* the page is navigating */
    }
  };
  await page('Runtime.enable').catch(() => {});
  setInterval(readTitle, 1000).unref();
  await readTitle();
}

main().catch((e) => {
  process.stdout.write(lib.LEAVE);
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
});
