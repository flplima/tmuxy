/**
 * Web push: a pane coming to need the user reaches the devices that turned
 * notifications on, encrypted for each.
 *
 * The device here is the test itself: a browser's side of a subscription —
 * its own P-256 keys and auth secret, and a push endpoint on localhost that
 * records what arrives — because a headless browser has no push service to
 * subscribe through. Everything else is the real chain: the subscription
 * handed to the server's API, an agent marking its pane through the CLI, the
 * server's watcher reading tmux, the notice encrypted and signed, and the
 * device decrypting it the way a browser does (RFC 8291).
 */

const crypto = require('crypto');
const http = require('http');
const { describeE2E, waitForShellPrompt, waitForCondition, TMUXY_URL } = require('./helpers');
const { tmuxyCli } = require('./helpers/cli');

/** A browser's half of web push: subscribe, and read what is pushed to it. */
async function fakeDevice() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const publicKey = ecdh.getPublicKey();
  const auth = crypto.randomBytes(16);
  const hkdf = (ikm, salt, info, length) =>
    Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const salt = body.subarray(0, 16);
      const keyId = body.subarray(21, 21 + body[20]);
      const sealed = body.subarray(21 + body[20]);
      const ikm = hkdf(
        ecdh.computeSecret(keyId),
        auth,
        Buffer.concat([Buffer.from('WebPush: info\0'), publicKey, keyId]),
        32,
      );
      const decipher = crypto.createDecipheriv(
        'aes-128-gcm',
        hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
        hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
      );
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      const record = Buffer.concat([
        decipher.update(sealed.subarray(0, sealed.length - 16)),
        decipher.final(),
      ]);
      received.push({
        headers: req.headers,
        notice: JSON.parse(record.subarray(0, record.length - 1).toString()),
      });
      res.writeHead(201).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/push/e2e`;
  const subscription = {
    endpoint,
    keys: { p256dh: publicKey.toString('base64url'), auth: auth.toString('base64url') },
  };
  return { subscription, received, close: () => server.close() };
}

const api = (method, route, body) =>
  fetch(`${TMUXY_URL}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** An agent saying what its pane is doing, as its hooks do. */
const paneState = (paneId, state) => tmuxyCli(['pane', 'state', state, paneId]);

describeE2E(
  'Scenario: a pane that needs the user is pushed to the devices that asked',
  {},
  (ctx) => {
    test('a device subscribes, an agent marks its pane needs-input, the device decrypts the notice', async () => {
      await ctx.setupPage();
      await waitForShellPrompt(ctx.page);
      const paneId = await ctx.page.evaluate(() => window.app?.view().activePaneId);
      const device = await fakeDevice();
      try {
        expect((await api('POST', '/api/push/subscription', device.subscription)).status).toBe(204);

        // The watcher's first read after a subscription only learns what is
        // already showing, and nothing outside says when it has happened. So
        // the pane enters the state again until a notice arrives: each entry
        // is news once the watcher is reading.
        let entries = 0;
        await waitForCondition(
          ctx.page,
          async () => {
            const ours = device.received.find((r) => r.notice.paneId === paneId);
            if (ours) return true;
            paneState(paneId, 'working');
            await new Promise((resolve) => setTimeout(resolve, 2500));
            paneState(paneId, 'needs-input');
            entries += 1;
            await new Promise((resolve) => setTimeout(resolve, 2500));
            return device.received.some((r) => r.notice.paneId === paneId);
          },
          45000,
          () => `a push for ${paneId} after ${entries} entries into needs-input`,
        );

        const { headers, notice } = device.received.find((r) => r.notice.paneId === paneId);
        expect(headers['content-encoding']).toBe('aes128gcm');
        expect(headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
        expect(notice.title).toMatch(/needs you$/);
        expect(notice.tag).toBe(`tmuxy-${paneId}-needs-input`);
        expect(notice.url).toBe(`/?session=${ctx.session.name}`);
        expect(notice.body).toContain(ctx.session.name);
      } finally {
        await api('DELETE', '/api/push/subscription', { endpoint: device.subscription.endpoint });
        device.close();
        paneState(paneId, 'idle');
      }
    }, 120000);
  },
);
