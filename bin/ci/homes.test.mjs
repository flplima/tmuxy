import { describe, expect, it } from 'vitest';
import { codeLines, inScope, scan, verdicts, writes } from './homes.mjs';

const option = {
  id: '@tmuxy-window-type',
  why: 'the option a window is tagged with',
  home: 'constants.rs',
  literals: ['@tmuxy-window-type'],
  scope: ['packages/tmuxy-ui/src/', 'packages/tmuxy-cli/bin/'],
  allow: ['packages/tmuxy-ui/src/domain/home.ts'],
};

describe('homes', () => {
  it('reads code lines only, by the file’s language', () => {
    const ts = "// '@tmuxy-window-type' in a comment\n * and in a doc\nconst a = 1;";
    expect(codeLines('a.ts', ts)).toEqual(['const a = 1;']);
    const sh = '# @tmuxy-window-type\nshow -v @tmuxy-window-type';
    expect(codeLines('packages/tmuxy-cli/bin/tmuxy/nav', sh)).toEqual([
      'show -v @tmuxy-window-type',
    ]);
    expect(writes(option, 'a.ts', ts)).toBe(false);
    expect(writes(option, 'packages/tmuxy-cli/bin/tmuxy/nav', sh)).toBe(true);
  });

  it('leaves tests, stories, fixtures, docs and other packages out of scope', () => {
    for (const file of [
      'packages/tmuxy-ui/src/x/__tests__/a.test.ts',
      'packages/tmuxy-ui/src/stories/A.stories.tsx',
      'packages/tmuxy-ui/src/stories/fixtures/a.json',
      'packages/tmuxy-core/src/groups/tests_ops.rs',
      'packages/tmuxy-ui/src/README.md',
      'packages/tmuxy-demo/app/page.tsx',
    ]) {
      expect(inScope(option, file), file).toBe(false);
    }
    expect(inScope(option, 'packages/tmuxy-ui/src/components/A.tsx')).toBe(true);
  });

  it('fails a new file that writes it, and an allowance the file no longer needs', () => {
    const files = {
      'packages/tmuxy-ui/src/domain/home.ts': "export const T = '@tmuxy-window-type';",
      'packages/tmuxy-ui/src/components/Copy.tsx': "const t = '@tmuxy-window-type';",
    };
    const errors = verdicts(scan([option], Object.keys(files), (f) => files[f]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      'packages/tmuxy-ui/src/components/Copy.tsx writes @tmuxy-window-type',
    );

    files['packages/tmuxy-ui/src/domain/home.ts'] = 'export const T = WINDOW_TYPE;';
    delete files['packages/tmuxy-ui/src/components/Copy.tsx'];
    const stale = verdicts(scan([option], Object.keys(files), (f) => files[f]));
    expect(stale).toEqual([
      '[homes] bin/ci/homes.json allows packages/tmuxy-ui/src/domain/home.ts to write @tmuxy-window-type, and it no longer does: drop it from the list.',
    ]);
  });

  it('matches a regex rule on code lines of the files it names', () => {
    const spawn = {
      ...option,
      id: 'tmux started',
      literals: undefined,
      regex: 'tmux_path\\(\\)',
      scope: ['packages/'],
      ext: ['.rs'],
      allow: [],
    };
    expect(writes(spawn, 'a.rs', 'let c = Command::new(tmux_path());')).toBe(true);
    expect(writes(spawn, 'a.rs', '/// calls tmux_path() first')).toBe(false);
    expect(inScope(spawn, 'packages/tmuxy-core/src/a.ts')).toBe(false);
  });
});
