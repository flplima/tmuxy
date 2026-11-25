/**
 * `package-lock.json` gives the root package and each workspace the version
 * its `package.json` does. A release writes the version by hand
 * (`.agents/skills/release/scripts/bump-version`), and `npm ci` accepts a
 * lockfile left behind, so nothing else notices.
 *
 * Part of the policy check (bin/ci/policy.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';

const said = (version) => (version === undefined ? 'no version' : `version ${version}`);

/** The policy check (bin/ci/policy.mjs). */
export function checkLockfileVersion(root, addError) {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const manifest = read('package.json');
  const lock = read('package-lock.json');
  const compare = (where, locked, file, written) => {
    if (locked !== written) {
      addError(
        `[version] package-lock.json ${where} has ${said(locked)}, ${file} ${said(written)}`,
      );
    }
  };
  compare('(top)', lock.version, 'package.json', manifest.version);
  compare('packages[""]', lock.packages?.['']?.version, 'package.json', manifest.version);
  for (const workspace of manifest.workspaces ?? []) {
    const file = `${workspace}/package.json`;
    compare(
      `packages["${workspace}"]`,
      lock.packages?.[workspace]?.version,
      file,
      read(file).version,
    );
  }
}
