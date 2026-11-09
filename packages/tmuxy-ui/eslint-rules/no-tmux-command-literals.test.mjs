import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import rule from './no-tmux-command-literals.mjs';

/** The rule's findings for `code` in `src/<path>`, allowing `allow`. */
function lint(code, path, allow = []) {
  const linter = new Linter({ configType: 'flat' });
  return linter
    .verify(
      code,
      {
        // The paths the tests name: plain-JS snippets parse whatever the extension.
        files: ['**/*.ts', '**/*.tsx'],
        plugins: { tmuxy: { rules: { 'no-tmux-command-literals': rule } } },
        rules: { 'tmuxy/no-tmux-command-literals': ['error', { allow }] },
      },
      // Under the working directory, where the config's `files` patterns resolve.
      `${process.cwd()}/src/${path}`,
    )
    .map((m) => m.message.match(/'([^']+)'/)?.[1]);
}

describe('tmuxy/no-tmux-command-literals', () => {
  it('refuses a string or template that starts with a tmux command, by name or alias', () => {
    expect(lint("const a = 'split-window -h';", 'components/X.ts')).toEqual(['split-window']);
    expect(lint('const a = `send-keys -t ${p} Enter`;', 'machines/x.ts')).toEqual(['send-keys']);
    expect(lint("const a = 'splitw ; breakp';", 'hooks/x.ts')).toEqual(['splitw']);
  });

  it('leaves words, comments and a command mid-sentence alone', () => {
    const fine = [
      "const a = 'run the build';",
      "const a = 'set a mark';",
      "const a = 'new tab';",
      '// split-window -h is what tmux runs',
      "const a = 'press to split-window';",
      "const a = 'split-windows';",
    ];
    for (const code of fine) expect(lint(code, 'components/X.ts')).toEqual([]);
  });

  it('lets the allowed files, a directory entry, tests and stories spell commands', () => {
    const code = "const a = 'select-pane -t %1';";
    expect(lint(code, 'domain/commands.ts', ['domain/commands.ts'])).toEqual([]);
    expect(lint(code, 'infra/guest/engine.ts', ['infra/guest/'])).toEqual([]);
    expect(lint(code, 'domain/commandsX.ts', ['domain/commands.ts'])).toEqual(['select-pane']);
    expect(lint(code, 'components/__tests__/x.test.ts')).toEqual([]);
    expect(lint(code, 'stories/X.stories.tsx')).toEqual([]);
  });
});
