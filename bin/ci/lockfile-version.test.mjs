import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLockfileVersion } from './lockfile-version.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const errorsIn = (root) => {
  const errors = [];
  checkLockfileVersion(root, (e) => errors.push(e));
  return errors;
};

describe('the lockfile’s versions', () => {
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  const repo = ({ top, entry, workspace }) => {
    dir = mkdtempSync(join(tmpdir(), 'tmuxy-lockfile-'));
    const write = (file, json) => writeFileSync(join(dir, file), JSON.stringify(json));
    mkdirSync(join(dir, 'ui'));
    write('package.json', { version: '1.2.0', workspaces: ['ui'] });
    write('ui/package.json', {});
    write('package-lock.json', {
      version: top,
      packages: { '': { version: entry }, ui: { version: workspace } },
    });
    return dir;
  };

  it('agree with every package.json as the repo is today', () => {
    expect(errorsIn(ROOT)).toEqual([]);
  });

  it('pass when they match, a workspace without a version included', () => {
    expect(errorsIn(repo({ top: '1.2.0', entry: '1.2.0' }))).toEqual([]);
  });

  it('name each place left behind', () => {
    expect(errorsIn(repo({ top: '1.1.0', entry: '1.0.0', workspace: '0.9.0' }))).toEqual([
      '[version] package-lock.json (top) has version 1.1.0, package.json version 1.2.0',
      '[version] package-lock.json packages[""] has version 1.0.0, package.json version 1.2.0',
      '[version] package-lock.json packages["ui"] has version 0.9.0, ui/package.json no version',
    ]);
  });
});
