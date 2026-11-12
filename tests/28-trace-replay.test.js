/**
 * A trace replays into a reproduction: the ops a session ran, rebuilt from
 * the trace's `store` lines and run again in a fresh session, with the
 * trace's ids mapped to live ones (`helpers/trace-replay.js`). The trace is
 * synthetic, written here, with ids no live pane has.
 */

const { describeE2E, waitForShellPrompt, waitForPaneCount } = require('./helpers');
const { replayTrace, storeActions } = require('./helpers/trace-replay');

const TRACE = [
  { layer: 'xstate', name: 'KEY_PRESS', phase: 'event' },
  { layer: 'store', name: 'Split', kind: 'vertical' },
  { layer: 'store', name: 'Split', kind: 'horizontal' },
  { layer: 'store', name: 'ZoomToggle', pane: '%40' },
  { layer: 'store', name: 'ZoomToggle', pane: '%40' },
  { layer: 'store', name: 'KillPane', pane: '%41' },
  // A resize needs a size, which a trace never holds: skipped.
  { layer: 'store', name: 'ResizePanes', pane: '%40' },
  // A pane first named after the skip: left unmapped, its op skipped.
  { layer: 'store', name: 'ZoomToggle', pane: '%77' },
  { layer: 'tmux', name: 'command', session: 'session-1' },
]
  .map((line) => JSON.stringify(line))
  .concat(['not json'])
  .join('\n');

describeE2E('Scenario: a trace replayed into a reproduction', {}, (ctx) => {
  test('the ops a trace holds run again, its ids mapped to live ones, and what it cannot rebuild is said', async () => {
    const { page } = ctx;
    await ctx.setupPage();
    await waitForShellPrompt(page);
    expect(storeActions(TRACE).map((a) => a.name)).toEqual([
      'Split',
      'Split',
      'ZoomToggle',
      'ZoomToggle',
      'KillPane',
      'ResizePanes',
      'ZoomToggle',
    ]);

    const result = await replayTrace(page, ctx.session, TRACE);

    expect(result.replayed).toEqual(['Split', 'Split', 'ZoomToggle', 'ZoomToggle', 'KillPane']);
    expect(result.skipped).toEqual(['ResizePanes', 'ZoomToggle']);
    expect(result.unmapped).toEqual(['%77']);
    // The trace's panes landed on live ones: the first named is the
    // session's first pane, the next one the next pane the replay made.
    expect(Object.keys(result.ids)).toEqual(['%40', '%41']);
    expect(Object.values(result.ids).every((id) => /^%\d+$/.test(id))).toBe(true);
    // Three panes made, one closed: two on screen.
    await waitForPaneCount(page, 2);
  }, 120000);
});
