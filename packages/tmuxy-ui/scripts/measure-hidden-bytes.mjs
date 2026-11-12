#!/usr/bin/env node
/**
 * What a pane nobody looks at costs the link: the bytes per second the
 * server's event stream (`GET /events`, SSE) carries to a browser while one
 * pane redraws an agent's spinner at ~2 KB/s, in three cases measured one
 * after another on the same session:
 *
 * - `quiet`: no spinner, the floor (heartbeats, status);
 * - `hidden`: the spinner in another tab, the one the browser shows idle;
 * - `visible`: the spinner's tab shown.
 *
 * The bytes are the ones Chrome received on the event stream's connection
 * (CDP `Network.dataReceived`), so what the link carries, not what the page
 * parsed. The report is relative by design: `hidden` against `visible` and
 * against what the spinner printed tells whether a hidden pane is sent in
 * full, whatever the machine.
 *
 *   node measure-hidden-bytes.mjs [--url URL] [--seconds N] [--out FILE] [--cdp URL]
 */

import fs from 'node:fs';
import { chromium } from 'playwright';
import { waitForReady } from './lib/perf-harness.mjs';
import { BUSY_BYTES_PER_SECOND, startBusyPanes } from './lib/busy-panes.mjs';

const argv = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};
const URL_BASE = opt('--url', 'http://localhost:9000');
const SECONDS = Number(opt('--seconds', '10'));
const OUT = opt('--out', null);
const CDP = opt('--cdp', null);

/** A tmux command through the client's own routing. */
const tmux = (page, command) =>
  page.evaluate((c) => window.app.send({ type: 'SEND_TMUX_COMMAND', command: c }), command);

/** Count the event stream's bytes from now on; `take()` reads and resets. */
async function streamMeter(page) {
  const cdp = await page.context().newCDPSession(page);
  const streams = new Set();
  let bytes = 0;
  cdp.on('Network.requestWillBeSent', (e) => {
    if (new URL(e.request.url).pathname === '/events') streams.add(e.requestId);
  });
  cdp.on('Network.dataReceived', (e) => {
    if (streams.has(e.requestId)) bytes += e.encodedDataLength || e.dataLength;
  });
  await cdp.send('Network.enable');
  return {
    streams: () => streams.size,
    take() {
      const was = bytes;
      bytes = 0;
      return was;
    },
  };
}

function adapterFor(page) {
  return {
    evaluate: (fn, arg) => page.evaluate(fn, arg),
    wait: (ms) => page.waitForTimeout(ms),
  };
}

/** Bytes per second on the stream over `SECONDS`, after a settle. */
async function rate(page, meter) {
  await page.waitForTimeout(1500);
  meter.take();
  await page.waitForTimeout(SECONDS * 1000);
  return Math.round(meter.take() / SECONDS);
}

async function main() {
  const browser = CDP
    ? await chromium.connectOverCDP(CDP)
    : await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
  const context = CDP
    ? (browser.contexts()[0] ?? (await browser.newContext()))
    : await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  // The meter is on before the page opens its stream, so the stream is seen.
  const meter = await streamMeter(page);
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForReady(adapterFor(page));
  if (meter.streams() === 0) throw new Error('no event stream seen: is this the web app?');

  const quiet = await rate(page, meter);

  // The spinner in a tab of its own (the server rewrites `neww` to the
  // split-and-break tmux takes safely), then back to the first: hidden.
  await tmux(page, 'neww');
  await page.waitForTimeout(1200);
  const busy = await startBusyPanes(adapterFor(page), { count: 1 });
  await tmux(page, 'last-window');
  const hidden = await rate(page, meter);

  // Its tab shown: visible.
  await tmux(page, 'last-window');
  const visible = await rate(page, meter);
  const load = busy.stop();
  await page.waitForTimeout(500);

  if (CDP) await page.close();
  else await browser.close();

  const report = {
    kind: 'hidden-bytes',
    target: 'web',
    seconds: SECONDS,
    spinnerBytesPerSecond: load.bytesPerPanePerSecond,
    requestedSpinnerBytesPerSecond: BUSY_BYTES_PER_SECOND,
    streamBytesPerSecond: { quiet, hidden, visible },
    // What a hidden spinner adds to the stream, per byte it printed.
    hiddenPerSpinnerByte:
      Math.round(((hidden - quiet) / Math.max(1, load.bytesPerPanePerSecond)) * 100) / 100,
    visiblePerSpinnerByte:
      Math.round(((visible - quiet) / Math.max(1, load.bytesPerPanePerSecond)) * 100) / 100,
  };
  const text = JSON.stringify(report, null, 2);
  if (OUT) fs.writeFileSync(OUT, `${text}\n`);
  console.log(text);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
