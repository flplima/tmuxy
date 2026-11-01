const fs = require('fs');
const os = require('os');
const path = require('path');
const { runCLI } = require('./helpers/run-cli');
const { runWidgetWithPaneGone } = require('./helpers/run-widget');

describe('CLI widget subcommands', () => {
  // The widget exec path uses `exec` to replace the process with a widget
  // script, which pipes into tmuxy-widget's `trap 'exec bash </dev/tty' EXIT`
  // — that fails without a tty. We test only help and error cases.

  describe('widget unknown', () => {
    test('errors on unknown widget subcommand', () => {
      const { stderr, exitCode } = runCLI(['widget', 'badcmd']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('Unknown widget command: badcmd');
      expect(stderr).toContain('Usage: tmuxy widget <command>');
    });
  });

  /**
   * A widget whose pane closed under it (its session killed) runs its exit
   * trap with a terminal that no longer takes writes. bash 3.2's `printf`
   * keeps the bytes it could not write, and every `$( … )` after it flushed
   * them into its own result: the title reset ESC ] 2 ; BEL landed inside the
   * run-shell line, cut the command at its `;`, and the line's
   * `echo $? >…status` wrote a file named ESC ] 2 into the pane's directory.
   * Here the reader of the widget's output leaves after the marker, so the
   * trap's writes fail the same way.
   */
  test('a widget whose pane is gone hands tmux a clean line on its way out', async () => {
    const { calls, files } = await runWidgetWithPaneGone('%5');
    // The mock logs an ESC byte as itself.
    expect(calls.some((line) => line.includes('\u001b'))).toBe(false);
    expect(calls.find((line) => line.includes('set-option -p -u'))).toContain(
      "set-option -p -u -t '%5' @tmuxy-pane-widget",
    );
    expect(files).toEqual(['tmux.log']);
  });

  // A preview reads the file it was opened on and nothing else, so what it
  // will not open is refused before any pane option is written.
  describe('preview (tmuxy open)', () => {
    test.each([['open'], ['widget', 'preview']])('%s --help describes the flags', (...cmd) => {
      const { stdout, exitCode, tmuxCalls } = runCLI([...cmd, '--help']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Usage: tmuxy-widget-preview [--net] [--no-theme] [file]');
      expect(tmuxCalls).toEqual([]);
    });

    test('refuses a file that is not a page or a markdown document', () => {
      const notAPage = path.resolve(__dirname, '../../package.json');
      const { stderr, exitCode, tmuxCalls } = runCLI(['open', notAPage]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('a preview shows .html and .md files');
      expect(tmuxCalls).toEqual([]);
    });

    test('refuses a file that does not exist', () => {
      const { stderr, exitCode, tmuxCalls } = runCLI(['open', '/no/such/notes.md']);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('not a file: /no/such/notes.md');
      expect(tmuxCalls).toEqual([]);
    });

    test('refuses an unknown option', () => {
      const { stderr, exitCode } = runCLI(['open', '--bogus', 'notes.md']);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('Unknown option: --bogus');
    });

    test('refuses a symlinked markdown or html document', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-open-symlink-'));
      try {
        const target = path.join(dir, 'secret');
        const link = path.join(dir, 'README.md');
        fs.writeFileSync(target, 'secret');
        fs.symlinkSync(target, link);
        const { stderr, exitCode, tmuxCalls } = runCLI(['open', link], {
          env: {
            TMUX_SOCKET: 'tmuxy',
            TMUX_PANE: '%1',
            MOCK_TMUX_PANE_PID: String(process.pid),
          },
        });
        expect(exitCode).toBe(1);
        expect(stderr).toContain('a symlink cannot be previewed');
        expect(tmuxCalls).toEqual([]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test('refuses a spoofed TMUX_PANE whose process is not an ancestor of the caller', () => {
      const doc = path.resolve(__dirname, '../../README.md');
      const { stderr, exitCode, tmuxCalls } = runCLI(['open', '--net', doc], {
        env: { TMUX_SOCKET: 'tmuxy', TMUX_PANE: '%1', MOCK_TMUX_PANE_PID: '999999' },
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain('cannot open a preview on another pane (%1)');
      // Only the read-only pane_pid lookup runs; no set-option mutation is issued.
      expect(tmuxCalls).toEqual([{ args: ['display-message', '-p', '-t', '%1', '#{pane_pid}'] }]);
    });
  });
});
