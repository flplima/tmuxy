/**
 * What every in-browser guest (the v86 snapshot, the CheerpX image) takes from
 * the repo: the i686 static binaries the pane-group scripts run, the `tmuxy`
 * CLI with its helper scripts, and the tmux config the app ships.
 */
import { chmod, cp, mkdir, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * The guest's tmuxy layout, as the app lays it out on a real machine (tmuxy-core
 * `session::Layout`): the shipped config and the scripts in the data dir, the
 * user's `tmuxy.conf` in the config dir, and tmux started with the chain, which
 * lives in the state dir.
 */
export const GUEST_DATA_DIR = '/root/.local/share/tmuxy';
export const GUEST_CONFIG_DIR = '/root/.config/tmuxy';
export const GUEST_STATE_DIR = '/root/.local/state/tmuxy';
export const GUEST_ENTRY_CONF = `${GUEST_STATE_DIR}/tmuxy.entry.conf`;

/** The config files the app ships, copied into the guest's data dir. */
export const GUEST_CONF_ASSETS = ['tmuxy.defaults.conf', 'tmuxy.essentials.conf'];
export const GUEST_CONF_ASSETS_DIR = join(REPO, 'packages', 'tmuxy-core', 'assets');

/**
 * The chain tmux starts with, as tmuxy-core's `entry_conf` builds it: the data
 * dir the essentials' aliases and the client's script commands name the
 * scripts by (`$TMUXY_DATA_DIR`), and the file Reload Config sources, then
 * the layers in order.
 */
export function guestEntryConf() {
  return [
    '# The config chain, as tmuxy builds it on a real machine.',
    `set-environment -g TMUXY_DATA_DIR ${GUEST_DATA_DIR}`,
    `set-environment -g TMUXY_ENTRY_CONF ${GUEST_ENTRY_CONF}`,
    `source-file ${GUEST_DATA_DIR}/tmuxy.essentials.conf`,
    `source-file ${GUEST_DATA_DIR}/tmuxy.defaults.conf`,
    `source-file -q ${GUEST_CONFIG_DIR}/tmuxy.conf`,
    `source-file ${GUEST_DATA_DIR}/tmuxy.essentials.conf`,
    '',
  ].join('\n');
}

/** The guest user's `tmuxy.conf`, overrides only: `defaultCommand` (bash as a
 *  non-login shell by default, so it skips /etc/profile, and any banner or PS1
 *  override there, and reads ~/.bashrc) as the pane command. */
export function guestTmuxyConf(defaultCommand = '/bin/bash') {
  return [
    "# Guest user config — overrides on top of tmuxy's defaults, edit freely.",
    `set -g default-command '${defaultCommand}'`,
    '',
  ].join('\n');
}

/** The guest's ~/.bashrc: a standard interactive prompt, and a UTF-8 locale:
 *  without one, readline takes the high bytes of an emoji or a CJK character
 *  for Meta key sequences (a typed 🔥 reached tmux as `__`) and miscounts
 *  widths on redisplay, clobbering the prompt after a pasted multibyte line.
 *  `host` is the prompt's host: `\h`, unless the guest cannot set a hostname. */
export function guestBashrc(host = '\\h') {
  return `export LANG=C.UTF-8 LC_ALL=C.UTF-8\nexport PS1='\\u@${host}:\\w\\$ '\n`;
}

/**
 * Cross-compile the guest's Rust binaries static for i686 and place each at
 * `<destDir>/<name>` (the guest has no tmuxy-server, so what the scripts need
 * from Rust ships on its own).
 */
export async function crossCompileGuestBinaries(names, destDir) {
  console.log(`… cross-compiling ${names.join(', ')} (i686-musl)`);
  // `CARGO` is cargo's own override; the default must be the rustup-managed
  // cargo, the one that knows the cross target.
  execFileSync(
    process.env.CARGO ?? 'cargo',
    [
      'build',
      ...names.flatMap((name) => ['-p', name, '--bin', name]),
      '--target',
      'i686-unknown-linux-musl',
      '--release',
    ],
    {
      cwd: REPO,
      env: { ...process.env, RUSTFLAGS: '-C linker=rust-lld -C target-feature=+crt-static' },
      stdio: 'inherit',
    },
  );
  await mkdir(destDir, { recursive: true });
  for (const name of names) {
    await cp(join(REPO, 'target', 'i686-unknown-linux-musl', 'release', name), join(destDir, name));
    await chmod(join(destDir, name), 0o755);
  }
}

/**
 * Copy the CLI dispatcher and its helper scripts as `<destBinDir>/tmuxy-cli`
 * and `<destBinDir>/tmuxy/*`, executable — the layout the dispatcher resolves
 * its helpers from.
 */
export async function stageTmuxyScripts(destBinDir) {
  const cliBin = join(REPO, 'packages', 'tmuxy-cli', 'bin');
  await mkdir(join(destBinDir, 'tmuxy'), { recursive: true });
  await cp(join(cliBin, 'tmuxy-cli'), join(destBinDir, 'tmuxy-cli'));
  await chmod(join(destBinDir, 'tmuxy-cli'), 0o755);
  for (const f of await readdir(join(cliBin, 'tmuxy'))) {
    await cp(join(cliBin, 'tmuxy', f), join(destBinDir, 'tmuxy', f), { recursive: true });
    await chmod(join(destBinDir, 'tmuxy', f), 0o755);
  }
}
