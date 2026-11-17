/**
 * `tmuxy pane listen`: the lines a preview pane receives (a page's
 * `tmuxy.emit`, a markdown form's controls), streamed to a plugin's handler
 * until the preview ends. The preview is played by the mock tmux (its tag)
 * and a log written where the widget writes it.
 */

const fs = require('fs');
const path = require('path');
const { runCLI } = require('./helpers/run-cli');
const { withScratchDir } = require('./helpers/env');
const { fakePreview, startListener, vanishingLog } = require('./helpers/run-listen');

const EMIT = (n) => JSON.stringify({ emit: { n } });

describe('tmuxy pane listen', () => {
  test('--help says what it prints, when it ends and how it fails', () => {
    const { stdout, exitCode, tmuxCalls } = runCLI(['pane', 'listen', '--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: tmuxy pane listen [target] [--from-start] [--wait DURATION]');
    expect(stdout).toContain('Exits 0 when the preview ends');
    expect(tmuxCalls).toEqual([]);
    expect(runCLI(['pane', '--help']).stdout).toMatch(/^ {2}listen +Print the lines a preview/m);
  });

  test('a pane that does not exist is exit 3, one with no preview exit 1', () =>
    withScratchDir('tmuxy-listen-', (home) => {
      const preview = fakePreview(home, '%5');
      const gone = runCLI(['pane', 'listen', '%9', '--json'], {
        env: { ...preview.env, MOCK_TMUX_GONE_PANES: '%9' },
      });
      expect(gone.exitCode).toBe(3);
      expect(JSON.parse(gone.stdout)).toEqual({
        ok: false,
        error: 'no such pane: %9',
        code: 3,
      });

      const shell = runCLI(['pane', 'listen', '%5', '--wait', '0'], { env: preview.env });
      expect(shell.exitCode).toBe(1);
      expect(shell.stderr).toContain('%5 shows no preview');

      const nowhere = runCLI(['pane', 'listen'], { env: preview.env });
      expect(nowhere.exitCode).toBe(2);
      expect(nowhere.stderr).toContain('target required outside a pane');
    }));

  /**
   * A plugin starts its listener, then the preview, in the same pane: the
   * listener waits for it, misses none of its lines, and ends with it,
   * after the last line the widget read before its tag went.
   */
  test('a listener started first waits for the preview, prints every line, and ends with it', () =>
    withScratchDir('tmuxy-listen-', async (home) => {
      const preview = fakePreview(home, '%5');
      const listener = startListener(home, ['%5'], preview.env);
      // Asked twice, so its first question had its answer: no preview yet.
      while (preview.asked() < 2) await new Promise((resolve) => setTimeout(resolve, 50));
      preview.start([EMIT(1)]);
      preview.receive('{"input":"name","type":"text","value":"a b"}');
      expect(await listener.waitForLines(2)).toEqual([
        EMIT(1),
        '{"input":"name","type":"text","value":"a b"}',
      ]);
      // Past its cap the log starts over as a new file, which it follows.
      preview.startOver();
      preview.receive(EMIT(2));
      await listener.waitForLines(3);
      preview.receive(EMIT(3));
      preview.end();
      const { code, stdout } = await listener.exited;
      expect(code).toBe(0);
      expect(stdout.split('\n').filter(Boolean)).toEqual([
        EMIT(1),
        '{"input":"name","type":"text","value":"a b"}',
        EMIT(2),
        EMIT(3),
      ]);
    }));

  /**
   * A preview that ends removes its log. Gone between two of the listener's
   * looks, it read as a log replaced, and reopening a file that is not there
   * ended the listener with status 1 (`set -e`), before the preview it
   * listened to had ended.
   */
  test('a log gone in the moment it is looked at ends nothing early: the listener ends with the preview, 0', () =>
    withScratchDir('tmuxy-listen-', async (home) => {
      const preview = fakePreview(home, '%5');
      const vanish = vanishingLog(home, preview.log);
      preview.start([EMIT(1)]);
      const listener = startListener(home, ['%5', '--from-start'], {
        ...preview.env,
        ...vanish.env,
      });
      expect(await listener.waitForLines(1)).toEqual([EMIT(1)]);
      vanish.arm();
      while (!vanish.done()) await new Promise((resolve) => setTimeout(resolve, 50));
      // Two more looks at the pane's tag with its log gone: still listening.
      const asked = preview.asked();
      while (listener.running() && preview.asked() < asked + 2) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(listener.running()).toBe(true);
      preview.end();
      const { code, stdout, stderr } = await listener.exited;
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      expect(stdout.split('\n').filter(Boolean)).toEqual([EMIT(1)]);
    }));

  test('joining a preview under way prints from the next line, or with --from-start from its first', () =>
    withScratchDir('tmuxy-listen-', async (home) => {
      const preview = fakePreview(home, '%5');
      preview.start([EMIT(1), EMIT(2)]);
      // A line the widget is still writing: the next one, printed whole.
      fs.appendFileSync(preview.log, '{"emit":');
      const ownLog = path.join(home, 'from-now.log');
      const fromNow = startListener(home, ['%5'], { ...preview.env, MOCK_TMUX_LOG: ownLog });
      const fromStart = startListener(home, ['%5', '--from-start'], preview.env);
      expect(await fromStart.waitForLines(2)).toEqual([EMIT(1), EMIT(2)]);
      // Its second question comes from its loop: it is reading the log.
      while (preview.asked(ownLog) < 2) await new Promise((resolve) => setTimeout(resolve, 50));
      fs.appendFileSync(preview.log, '"late"}\n');
      expect(await fromNow.waitForLines(1)).toEqual(['{"emit":"late"}']);
      expect(await fromStart.waitForLines(3)).toEqual([EMIT(1), EMIT(2), '{"emit":"late"}']);
      preview.end();
      expect((await fromNow.exited).code).toBe(0);
      expect((await fromStart.exited).code).toBe(0);
    }));
});
