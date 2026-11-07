import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Node release is bin/toolchain's: CI asks it through setup-node-rust,
 * bin/devcontainer passes it to the image build, and the one copy left — the
 * Dockerfile's default, for a host that builds from devcontainer.json alone
 * — is held to it here.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const toolchain = (fact) =>
  execFileSync(path.join(ROOT, 'bin/toolchain'), [fact], { encoding: 'utf8' }).trim();

function filesUnder(dir) {
  return fs
    .readdirSync(path.join(ROOT, dir), { recursive: true })
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => path.join(dir, f));
}

describe('the Node release is written down once', () => {
  it("the devcontainer image's default is bin/toolchain's", () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, '.devcontainer/Dockerfile'), 'utf8');
    expect(/^ARG NODE_VERSION=(\S+)$/m.exec(dockerfile)?.[1]).toBe(toolchain('node-version'));
  });

  it('no workflow or action names a release of its own', () => {
    const named = [...filesUnder('.github/workflows'), ...filesUnder('.github/actions')].filter(
      (file) => /node-version:\s*['"]?\d/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')),
    );
    expect(named).toEqual([]);
  });
});
