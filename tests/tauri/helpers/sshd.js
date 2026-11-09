/**
 * A real ssh host for the desktop suite's ssh windows: the image in
 * tests/tauri/sshd, run on a free loopback port, with this run's own
 * password and certificate authority. A key signed by that CA, for the
 * user `tester`, is the certificate login.
 *
 * Docker is the one thing it needs beyond the suite's own tools. CI sets
 * `TMUXY_E2E_REQUIRE_DOCKER`, which turns a missing Docker into a failure;
 * elsewhere the ssh tests say why they did not run.
 */

const { execFileSync, execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const IMAGE = 'tmuxy-test-sshd';
const USER = 'tester';

function docker(args, options = {}) {
  const out = execFileSync('docker', args, { encoding: 'utf8', timeout: 300000, ...options });
  // Nothing comes back when stdout is ignored.
  return (out ?? '').trim();
}

/** Whether a Docker daemon answers. */
function dockerAvailable() {
  try {
    docker(['version', '--format', '{{.Server.Version}}'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/** `ssh-keygen` quietly, with no passphrase. */
function keygen(...args) {
  execFileSync('ssh-keygen', ['-q', ...args], { stdio: 'ignore' });
}

/**
 * Build the image, start a container and give it this run's password and CA.
 *
 * @returns {{ port: number, user: string, password: string, key: string,
 *   certificate: string, fingerprint: string, exec: (cmd: string) => string,
 *   stop: () => void }}
 */
function startSshd() {
  docker(['build', '-q', '-t', IMAGE, path.join(__dirname, '..', 'sshd')]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-sshd-'));
  const password = crypto.randomBytes(12).toString('base64url');
  keygen('-t', 'ed25519', '-N', '', '-f', path.join(dir, 'ca'));
  keygen('-t', 'ed25519', '-N', '', '-f', path.join(dir, 'id_ed25519'));
  keygen(
    '-s',
    path.join(dir, 'ca'),
    '-I',
    'tmuxy-suite',
    '-n',
    USER,
    '-V',
    '+1h',
    path.join(dir, 'id_ed25519.pub'),
  );

  const name = `tmuxy-test-sshd-${process.pid}`;
  docker(['rm', '-f', name], { stdio: 'ignore' });
  docker(['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::22', IMAGE]);
  const stop = () => {
    try {
      docker(['rm', '-f', name], { stdio: 'ignore' });
    } catch {
      // Already gone.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    docker(['cp', path.join(dir, 'ca.pub'), `${name}:/etc/ssh/tmuxy_ca.pub`]);
    // On stdin, never a command line.
    docker(['exec', '-i', name, 'chpasswd'], { input: `${USER}:${password}\n` });
    const port = Number(docker(['port', name, '22']).split('\n')[0].split(':').pop());

    // Ready when it hands out its host key; that key's fingerprint is the one
    // the splash page must show.
    let fingerprint = '';
    const deadline = Date.now() + 20000;
    while (!fingerprint && Date.now() < deadline) {
      try {
        const listed = execSync(
          `ssh-keyscan -T 2 -t ed25519 -p ${port} 127.0.0.1 2>/dev/null | ssh-keygen -lf -`,
          { encoding: 'utf8' },
        );
        fingerprint = (listed.match(/SHA256:\S+/) || [''])[0];
      } catch {
        // Not listening yet.
      }
    }
    if (!fingerprint) throw new Error(`sshd in ${name} never answered on port ${port}`);

    return {
      port,
      user: USER,
      password,
      key: path.join(dir, 'id_ed25519'),
      certificate: path.join(dir, 'id_ed25519-cert.pub'),
      fingerprint,
      exec: (cmd) => docker(['exec', '-u', USER, name, 'sh', '-c', cmd]),
      stop,
    };
  } catch (e) {
    stop();
    throw e;
  }
}

module.exports = { dockerAvailable, startSshd };
