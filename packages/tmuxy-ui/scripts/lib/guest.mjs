/**
 * What every in-browser guest (the v86 snapshot, the CheerpX image) takes from
 * the repo: the i686 static binaries the CLI scripts run, the `tmuxy`
 * CLI with its helper scripts, and the tmux config the app ships.
 */
import { readFileSync } from 'node:fs';
import { chmod, cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * The guest's tmuxy layout, and the config chain tmux starts with there:
 * tmuxy-core's own, generated into `guest.gen.json` (by
 * `tmuxy-core/tests/generated_constants.rs`), so the guest cannot drift from
 * what the app builds on a real machine.
 */
const GENERATED = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'guest.gen.json'), 'utf8'),
);
export const GUEST_DATA_DIR = GENERATED.dataDir;
export const GUEST_CONFIG_DIR = GENERATED.configDir;
export const GUEST_STATE_DIR = GENERATED.stateDir;
export const GUEST_ENTRY_CONF = GENERATED.entryConf;

/** The config files the app ships, copied into the guest's data dir. */
export const GUEST_CONF_ASSETS = GENERATED.confAssets;
export const GUEST_CONF_ASSETS_DIR = join(REPO, 'packages', 'tmuxy-core', 'assets');

/** The chain tmux starts with: tmuxy-core's entry file for the guest's layout. */
export function guestEntryConf() {
  return GENERATED.entryConfText;
}

/** The guest user's `tmuxy.conf`, overrides only: `defaultCommand` (bash as a
 *  non-login shell by default, so it skips /etc/profile, and any banner or PS1
 *  override there, and reads ~/.bashrc) as the pane command. */
export function guestTmuxyConf(defaultCommand = '/bin/bash', extra = []) {
  return [
    "# Guest user config — overrides on top of tmuxy's defaults, edit freely.",
    `set -g default-command '${defaultCommand}'`,
    ...extra,
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
 * `<destDir>/<name>`. The guest has no tmuxy-server, so the CLI's verbs ship
 * as `tmuxy-verbs`, without the default `native` feature: what needs the
 * server's async transport stays out, and answers as not available.
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
      '--no-default-features',
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
  // With the version written in, as the app mirrors it (`session::assets`).
  const { version } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const cli = readFileSync(join(cliBin, 'tmuxy-cli'), 'utf8');
  await writeFile(join(destBinDir, 'tmuxy-cli'), cli.replaceAll('@TMUXY_VERSION@', version));
  await chmod(join(destBinDir, 'tmuxy-cli'), 0o755);
  for (const f of await readdir(join(cliBin, 'tmuxy'))) {
    await cp(join(cliBin, 'tmuxy', f), join(destBinDir, 'tmuxy', f), { recursive: true });
    await chmod(join(destBinDir, 'tmuxy', f), 0o755);
  }
}
