/**
 * A page talks back: `tmuxy.emit` in a page shown with `tmuxy open` types a
 * line into its own pane, `tmuxy pane listen` hands it on, and once the
 * preview ends nothing a page says reaches the shell (docs/PLUGINS.md,
 * "Two-way pages").
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  describeE2E,
  typeInTerminal,
  pressEnter,
  waitForShellPrompt,
  waitForCondition,
  waitForTerminalText,
} = require('./helpers');
const { tmuxExec } = require('./helpers/tmux-socket');
const { tmuxyCliStream } = require('./helpers/cli');
const { activePreview, openPreview, previewFrame } = require('./helpers/preview-widget');

/**
 * The command the app sends for a line to a preview (`previewLine` in
 * `domain/commandHelpers.ts`, pinned there and in the router's tests): the
 * line staged, then pasted only inside tmux's check that the pane previews.
 */
function previewLineCommand(paneId, line) {
  const quoted = Array.from(Buffer.from(`${line}\n`), (b) =>
    /[A-Za-z0-9 ]/.test(String.fromCharCode(b))
      ? String.fromCharCode(b)
      : `\\${b.toString(8).padStart(3, '0')}`,
  ).join('');
  const buffer = `tmuxy-preview-${paneId.slice(1)}`;
  return (
    `set-buffer -b ${buffer} "${quoted}"\n` +
    `if-shell -F -t ${paneId} '#{==:#{@tmuxy-pane-widget},preview}' ` +
    `{ paste-buffer -d -b ${buffer} -t ${paneId} } { delete-buffer -b ${buffer} }`
  );
}

/** A mutation sent to the server as a client sends one. */
function sendCommand(page, command) {
  return page.evaluate(async (cmd) => {
    const session = new URLSearchParams(location.search).get('session') ?? 'tmuxy';
    const response = await fetch(`/commands?session=${encodeURIComponent(session)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'run_tmux_command', args: { command: cmd } }),
    });
    return response.status;
  }, command);
}

describeE2E('Scenario: a page shown with tmuxy open talks back', {}, (ctx) => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxy-emit-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a page talks back: tmuxy.emit types a line into its own pane for a listener, and nothing once the preview ends', async () => {
    await ctx.setupPage();
    await waitForShellPrompt(ctx.page);

    // What a hostile page would like a shell to run, were the line typed
    // into one.
    const marker = path.join(dir, 'ran');
    const value = { verdict: 'approve', note: `$(touch ${marker})` };
    const line = JSON.stringify({ emit: value });
    const page = path.join(dir, 'review.html');
    fs.writeFileSync(
      page,
      `<!doctype html><html><head><title>Review</title></head><body>
<button id="approve" style="font-size: 32px; margin: 40px"
  onclick='window.sent = tmuxy.emit(${JSON.stringify(value)})'>Approve</button>
</body></html>\n`,
    );
    await openPreview(ctx, page);
    let shown = null;
    await waitForCondition(
      ctx.page,
      async () => {
        shown = await activePreview(ctx.page);
        return shown.frame?.box?.height > 0 && shown.frame.title === 'Review';
      },
      30000,
      () => `the page in its frame (${JSON.stringify(shown)})`,
    );
    const paneId = shown.paneId;

    // A plugin's handler, reading what the preview receives until it ends.
    const listener = tmuxyCliStream(['pane', 'listen', paneId, '--from-start']);

    const frameBox = await (await ctx.page.$('iframe.preview-frame')).boundingBox();
    const button = await previewFrame(ctx.page).evaluate(() => {
      const r = document.getElementById('approve').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, height: r.height };
    });
    expect(button.height).toBeGreaterThan(0);
    await ctx.page.mouse.click(frameBox.x + button.x, frameBox.y + button.y);
    await waitForCondition(
      ctx.page,
      async () => (await previewFrame(ctx.page).evaluate(() => window.sent)) === true,
      10000,
      'tmuxy.emit to hand the value to the app',
    );
    await waitForCondition(
      ctx.page,
      async () => tmuxExec(`capture-pane -p -t '${paneId}'`).includes(line),
      10000,
      () => `the line under the preview (${tmuxExec(`capture-pane -p -t '${paneId}'`)})`,
    );
    // The listener has it before the preview ends: one whose first look came
    // after the end would find no preview to read, and print nothing.
    await waitForCondition(
      ctx.page,
      async () => listener.printed().includes(line),
      10000,
      () => `the listener to print the line (${JSON.stringify(listener.printed())})`,
    );

    // Ctrl+C from inside the page ends the preview, and the listener with it.
    await ctx.page.keyboard.press('Control+c');
    await waitForCondition(
      ctx.page,
      async () => !(await activePreview(ctx.page)).widget,
      15000,
      'Ctrl+C in the page to close the preview',
    );
    await waitForShellPrompt(ctx.page);
    // Its stderr is compared too, so a listener that ended early says why.
    expect(await listener.exited).toEqual({ code: 0, stdout: `${line}\n`, stderr: '' });

    // The pane is a shell now. A page's line that arrives late, sent as the
    // app sends one, is refused by tmux and the shell reads nothing: what
    // the shell is typed next is the first thing it runs.
    expect(await sendCommand(ctx.page, previewLineCommand(paneId, line))).toBe(200);
    await typeInTerminal(ctx.page, 'echo ALIVE_$((6*7))');
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, 'ALIVE_42', 15000);
    expect(tmuxExec(`capture-pane -p -t '${paneId}'`)).not.toContain('"emit"');
    expect(fs.existsSync(marker)).toBe(false);
  }, 120000);
});
