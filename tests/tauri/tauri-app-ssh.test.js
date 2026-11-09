/**
 * A new window attached over ssh from its splash page, to a real host: an
 * sshd in a container (helpers/sshd.js), signed in to with a password and
 * with a certificate. What is checked is what a person would: the host's
 * fingerprint asked about before anything is sent, the remote shell running
 * what is typed, and nothing left behind once the window closes — no
 * connection, no secret on disk.
 */

const fs = require('fs');
const { execSync } = require('child_process');
const {
  createTauriTestContext,
  invokeWindowCommand,
  waitForTerminalText,
  typeKeys,
  pressKey,
} = require('./helpers/wdio-client');
const { dockerAvailable, startSshd } = require('./helpers/sshd');
const {
  openSplashWindow,
  splashField,
  splashButton,
  closeThisWindow,
} = require('./helpers/splash');
const { sshKnownHosts } = require('./helpers/tauri-driver');
const { waitForCondition } = require('../helpers/browser');

const ctx = createTauriTestContext();
let host = null;
let unavailable = null;

beforeAll(() => {
  if (!dockerAvailable()) {
    if (process.env.TMUXY_E2E_REQUIRE_DOCKER)
      throw new Error('Docker is required here and did not answer');
    unavailable = 'no Docker daemon: the ssh windows need a host to sign in to';
    return;
  }
  host = startSshd();
}, 300000);

afterAll(() => host?.stop());

afterEach(async () => {
  await ctx.afterEachHook();
});

/** The ssh processes riding a window's config (`/tmp/tmuxy-ssh-<uid>/<label>.conf`). */
const sshProcesses = () =>
  execSync(`ps -eo args | grep 'tmuxy-ssh-${process.getuid()}/.*\\.conf' | grep -v grep || true`, {
    encoding: 'utf8',
  }).trim();

/** The secrets the windows' connections were handed, still on disk. */
const secretsOnDisk = () => {
  const dir = `/tmp/tmuxy-ssh-${process.getuid()}`;
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.pass')) : [];
};

/**
 * Fill the ssh form, connect, trust the host once its fingerprint (the
 * container's own) is shown, and see the remote shell run a line.
 */
async function signInAndRun(driver, fill, marker) {
  for (const [label, value] of Object.entries({
    Host: '127.0.0.1',
    Port: String(host.port),
    User: host.user,
    ...fill,
  })) {
    const input = await splashField(driver, label);
    await input.waitForDisplayed({ timeout: 20000 });
    await input.setValue(value);
  }
  await (await splashButton(driver, 'Connect')).click();
  const ask = await driver.$('[role="alertdialog"]');
  await ask.waitForDisplayed({ timeout: 30000 });
  const question = await ask.getText();
  expect(question).toContain(`First connection to ${host.user}@127.0.0.1:${host.port}`);
  expect(question).toContain(`ED25519 ${host.fingerprint}`);
  await (await splashButton(driver, 'Trust and connect')).click();

  await (await driver.$('.pane-layout-item')).waitForDisplayed({ timeout: 40000 });
  await typeKeys(driver, `echo ${marker}_$(whoami)`);
  await pressKey(driver, 'Enter');
  await waitForTerminalText(driver, `${marker}_${host.user}`, 20000);
}

describe('ssh windows', () => {
  test('a password signs in: a wrong one is refused with the reason, the right one attaches, and the window leaves nothing behind', async () => {
    if (unavailable) return console.warn(`skipped: ${unavailable}`);
    const { driver } = await ctx.setupApp();
    const { mainHandle, splashHandle } = await openSplashWindow(driver);

    // Refused: ssh's own words, under the form, which stays as filled.
    for (const [label, value] of Object.entries({
      Host: '127.0.0.1',
      Port: String(host.port),
      User: host.user,
      'Password or key passphrase': 'not-the-password',
    })) {
      const input = await splashField(driver, label);
      await input.waitForDisplayed({ timeout: 20000 });
      await input.setValue(value);
    }
    await (await splashButton(driver, 'Connect')).click();
    await (await driver.$('[role="alertdialog"]')).waitForDisplayed({ timeout: 30000 });
    await (await splashButton(driver, 'Trust and connect')).click();
    const refused = await driver.$('[role="alert"]');
    await refused.waitForDisplayed({ timeout: 30000 });
    expect(await refused.getText()).toContain('Permission denied');
    expect(secretsOnDisk()).toEqual([]);

    // The right password. The host is trusted now, so no question comes.
    const password = await splashField(driver, 'Password or key passphrase');
    await password.clearValue();
    await password.setValue(host.password);
    await (await splashButton(driver, 'Connect')).click();
    await (await driver.$('.pane-layout-item')).waitForDisplayed({ timeout: 40000 });
    await typeKeys(driver, 'echo PASSWORD_$(whoami)');
    await pressKey(driver, 'Enter');
    await waitForTerminalText(driver, `PASSWORD_${host.user}`, 20000);
    // Signed in, and the password is on disk nowhere, its file removed.
    expect(secretsOnDisk()).toEqual([]);
    // Trusted in the suite's own known-hosts file, hashed or not.
    execSync(`ssh-keygen -F '[127.0.0.1]:${host.port}' -f ${sshKnownHosts()}`, { stdio: 'ignore' });

    await driver.switchToWindow(mainHandle);
    const titles = (await invokeWindowCommand(driver, 'list_gui_windows')).map((w) => w.title);
    expect(titles).toContain(`tmuxy — ${host.user}@127.0.0.1:${host.port}`);
    // The window's client is on the remote tmux server's default session.
    expect(host.exec('tmux -L tmuxy ls')).toMatch(/^tmuxy: .*\(attached\)/m);
    expect(sshProcesses()).not.toBe('');

    await driver.switchToWindow(splashHandle);
    await closeThisWindow(driver, mainHandle);
    await waitForCondition(
      null,
      () => sshProcesses() === '',
      15000,
      () => `the window's ssh to end (left: ${sshProcesses()})`,
    );
  }, 240000);

  test('a certificate signs in with its key and no password', async () => {
    if (unavailable) return console.warn(`skipped: ${unavailable}`);
    // A host key trusted by the test before is not this question's: start clean.
    fs.rmSync(sshKnownHosts(), { force: true });
    const { driver } = await ctx.setupApp();
    const { mainHandle } = await openSplashWindow(driver);
    await signInAndRun(
      driver,
      { 'Key file': host.key, Certificate: host.certificate },
      'CERTIFICATE',
    );
    // The key alone is not in authorized_keys: only the CA's signature lets it in.
    expect(host.exec('cat ~/.ssh/authorized_keys 2>/dev/null || true')).toBe('');
    await closeThisWindow(driver, mainHandle);
    await waitForCondition(
      null,
      () => sshProcesses() === '',
      15000,
      () => `the window's ssh to end (left: ${sshProcesses()})`,
    );
  }, 240000);
});
