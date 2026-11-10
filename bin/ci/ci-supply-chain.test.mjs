import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpinned, workflowFiles } from './workflow-pins.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(join(ROOT, file), 'utf8');
const SHA = 'a'.repeat(40);

describe('every action and install a workflow runs is pinned', () => {
  it('holds for every workflow and composite action in the repository', () => {
    const problems = workflowFiles(ROOT).flatMap((file) =>
      unpinned(read(file)).map(([line, problem]) => `${file}:${line}: ${problem}`),
    );
    expect(problems).toEqual([]);
  });

  it('flags a tag, a branch and an unversioned cargo install, and passes a sha and a locked version', () => {
    const flagged = unpinned(
      [
        '      - uses: swatinem/rust-cache@v2',
        '      - uses: dtolnay/rust-toolchain@stable',
        '        run: cargo install tauri-webdriver',
        '        run: cargo install tauri-webdriver --version 0.2.0',
      ].join('\n'),
    ).map(([line]) => line);
    expect(flagged).toEqual([1, 2, 3, 4]);

    expect(
      unpinned(
        [
          `      - uses: actions/checkout@${SHA} # v7`,
          '      - uses: ./.github/actions/install-tmux',
          '      # `cargo install x` in a comment is prose',
          '        run: cargo install tauri-webdriver --version 0.2.0 --locked',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});

describe('the release build keeps its credentials to the steps that sign', () => {
  const workflow = read('.github/workflows/build-app.yml');
  const job = workflow.slice(
    workflow.indexOf('\n  build:\n'),
    workflow.indexOf('\n  upgrade-path:\n'),
  );
  // A step of the job starts at a six-space `- `.
  const [header, ...steps] = job.split(/\n(?= {6}- )/);
  const name = (step) => /name: (.+)/.exec(step)?.[1] ?? step.split('\n')[0].trim();
  const handsOut = (text) => /secrets\.APPLE_\w+\s*(?:\|\||\}\})/.test(text);

  it('grants a read-only token unless a job asks for more', () => {
    expect(workflow).toMatch(/^permissions:\n(?:#.*\n)*\s+contents: read$/m);
  });

  it('puts no signing secret on the job, only on the steps that stage, sign and notarize', () => {
    expect(handsOut(header)).toBe(false);
    expect(steps.filter(handsOut).map(name)).toEqual([
      'Stage the notarization key (macOS)',
      'Build Tauri app',
      'Notarize and staple the DMG itself (macOS)',
    ]);
  });

  it('deletes the notarization key after notarizing and before installing the smoke-test driver', () => {
    const at = (title) => steps.findIndex((step) => name(step) === title);
    const deleted = at('Delete the notarization key (macOS)');
    expect(deleted).toBeGreaterThan(at('Notarize and staple the DMG itself (macOS)'));
    expect(deleted).toBeLessThan(at('Install smoke test deps (macOS)'));
    expect(steps[deleted]).toMatch(/if: always\(\)/);
    expect(steps[deleted]).toContain('rm -rf "$HOME/private_keys"');
  });
});

describe('Dependabot action bumps', () => {
  it('wait a week, and come apart into GitHub-owned and third-party PRs', () => {
    const actions = read('.github/dependabot.yml').split('package-ecosystem: github-actions')[1];
    expect(actions).toMatch(/cooldown:\n\s+default-days: 7/);
    expect(actions).toMatch(/patterns: \["actions\/\*"\]/);
    expect(actions).toMatch(/exclude-patterns: \["actions\/\*"\]/);
  });
});
