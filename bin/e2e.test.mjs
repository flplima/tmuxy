import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E = join(dirname(fileURLToPath(import.meta.url)), 'e2e');

// Which tmux a run uses, with `npx` and `tmux` played by scripts: no jest, no
// browser, no tmux server.
describe('bin/e2e picks the tmux', () => {
  let dir;
  const script = (name, body) =>
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tmuxy-e2e-bin-'));
    script('npx', 'echo "TMUX_BIN=${TMUX_BIN-unset}"');
    script('tmux', 'echo "tmux 9.9-on-path"');
    script('other-tmux', 'echo "tmux 3.2a"');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (env) => {
    const base = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
    delete base.TMUXY_E2E_TMUX_BIN;
    delete base.TMUX_BIN;
    return spawnSync('bash', [E2E], { cwd: dir, env: { ...base, ...env }, encoding: 'utf8' });
  };

  it('ignores an inherited TMUX_BIN and says the tmux on PATH', () => {
    const { status, stdout, stderr } = run({ TMUX_BIN: '/nonexistent' });
    expect(status).toBe(0);
    expect(stdout).toBe('TMUX_BIN=unset\n');
    expect(stderr).toContain(`bin/e2e: tmux 9.9-on-path at ${join(dir, 'tmux')}\n`);
  });

  it.each([
    ['a path', () => join(dir, 'other-tmux')],
    ['a command', () => 'other-tmux'],
    ['a path relative to the caller', () => './other-tmux'],
  ])('runs the tmux TMUXY_E2E_TMUX_BIN names by %s', (_, named) => {
    const { status, stdout, stderr } = run({
      TMUX_BIN: '/nonexistent',
      TMUXY_E2E_TMUX_BIN: named(),
    });
    expect(status).toBe(0);
    const used = stdout.trim().replace('TMUX_BIN=', '');
    expect(isAbsolute(used)).toBe(true);
    expect(used.endsWith('/other-tmux')).toBe(true);
    expect(stderr).toContain(`bin/e2e: tmux 3.2a at ${used}\n`);
  });

  it('stops before jest when the named tmux is not there', () => {
    const { status, stdout, stderr } = run({ TMUXY_E2E_TMUX_BIN: '/nonexistent' });
    expect(status).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain("no executable tmux at '/nonexistent' (TMUXY_E2E_TMUX_BIN)");
  });
});
