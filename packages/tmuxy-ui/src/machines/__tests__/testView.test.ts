import { describe, expect, it } from 'vitest';
import { createInitialContext } from '../app/context';
import { selectTestView } from '../testView';
import { modelPane, modelWindow } from '../../test/model';
import { pid, wid } from '../../test/wire';

const front = wid('@1');
const back = wid('@2');
const floatWindow = wid('@3');

const context = (over = {}) => ({
  ...createInitialContext(),
  activeWindowId: front,
  activePaneId: pid('%1'),
  windows: [
    modelWindow(front, 1, { active: true }),
    modelWindow(back, 2),
    modelWindow(floatWindow, 3, { windowType: 'float' }),
  ],
  panes: [
    modelPane(pid('%1'), front, { active: true }),
    modelPane(pid('%2'), back),
    modelPane(pid('%3'), floatWindow),
  ],
  floatPanes: {
    [pid('%3')]: { paneId: pid('%3'), parentWindowId: front, width: 400, height: 300 },
  },
  ...over,
});

describe('the test view', () => {
  it("shows the front tab's panes and its float, never a background tab's", () => {
    expect(selectTestView(context()).visiblePaneIds.sort()).toEqual(['%1', '%3']);
    expect(
      selectTestView(context({ activeWindowId: back, activePaneId: pid('%2') })).visiblePaneIds,
    ).toEqual(['%2']);
  });

  it('names the float that holds the keyboard, and no pane while the panes do', () => {
    expect(selectTestView(context()).keyboardTarget).toEqual({ kind: 'panes', paneId: null });
    expect(
      selectTestView(context({ keyboardOwner: { kind: 'float', paneId: pid('%3') } }))
        .keyboardTarget,
    ).toEqual({ kind: 'float', paneId: '%3' });
  });

  it('names the prefix key only once the bindings for the key after it have arrived', () => {
    expect(selectTestView(context()).prefixKey).toBeNull();
    const keybindings = {
      prefix_key: 'C-a',
      repeat_time_ms: 500,
      prefix_bindings: [{ key: 'c', command: 'new-window', description: '' }],
      root_bindings: [],
      tables: {},
    };
    expect(selectTestView(context({ keybindings })).prefixKey).toBe('C-a');
  });

  it('lists the plugin actions the menus offer', () => {
    const plugins = [
      {
        name: 'demo',
        actions: [{ id: 'grab' }, { id: 'split' }],
        linkHosts: [],
        textLinks: false,
      },
    ];
    expect(selectTestView(context({ plugins })).pluginActions).toEqual(['demo:grab', 'demo:split']);
  });

  it("carries only the active pane's scrollback", () => {
    expect(selectTestView(context()).copyMode).toBeNull();
    const view = selectTestView(
      context({
        copyModeStates: {
          [pid('%2')]: { ...scrollback(), mode: 'copy' },
          [pid('%1')]: { ...scrollback(), mode: 'scroll', cursorRow: 7 },
        },
      }),
    );
    expect(view.copyMode).toMatchObject({ mode: 'scroll', cursorRow: 7 });
  });
});

/** A scrollback record with nothing loaded. */
function scrollback() {
  return {
    mode: 'copy' as const,
    lines: new Map(),
    totalLines: 24,
    historySize: 0,
    loadedRanges: [],
    loading: false,
    width: 80,
    height: 24,
    cursorRow: 0,
    cursorCol: 0,
    selectionMode: null,
    selectionAnchor: null,
    scrollTop: 0,
  };
}
