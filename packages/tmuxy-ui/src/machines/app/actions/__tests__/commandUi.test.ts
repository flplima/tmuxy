import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import type { TmuxClientModel, TmuxSnapshot } from '../../../../domain/store/types';
import { pid, wid } from '../../../../test/wire';
import { appMachine } from '../../appMachine';
import { fillTemplate } from '../commandUi';

describe('fillTemplate & command prompt expansion', () => {
  it('escapes leading tilde, shell/tmux metacharacters, and C0/C1 controls inside %%% templates', () => {
    expect(fillTemplate('rename-window -- "%%%"', '~root/dir')).toBe(
      'rename-window -- "\\176root/dir"',
    );
    expect(fillTemplate('rename-window -- "%%%"', 'a"b\\c$d`e\nf\rg\u009b201~')).toBe(
      'rename-window -- "a\\"b\\\\c\\$d\\`e\\012f\\015g\\302\\233201~"',
    );
  });

  it("leaves dollar replacement patterns ($&, $$, $') literal when expanding #W and #S", () => {
    const actor = createActor(appMachine).start();
    actor.send({ type: 'TMUX_CONNECTED' });
    const snapshot: TmuxSnapshot = {
      panes: [
        {
          id: 1,
          tmuxId: pid('%1'),
          windowId: wid('@1'),
          content: [],
          cursorX: 0,
          cursorY: 0,
          width: 80,
          height: 23,
          x: 0,
          y: 1,
          active: true,
          command: 'bash',
          title: '',
          borderTitle: '',
          inMode: false,
          copyCursorX: 0,
          copyCursorY: 0,
          alternateOn: false,
          mouseAnyFlag: false,
          paused: false,
          historySize: 0,
          selectionPresent: false,
          selectionStartX: 0,
          selectionStartY: 0,
          cursorShape: 0,
          cursorHidden: false,
        },
      ],
      windows: [
        {
          id: wid('@1'),
          index: 0,
          name: "win-$&-$'",
          active: true,
          windowType: 'tab',
          floatParent: null,
          floatWidth: null,
          floatHeight: null,
          floatDrawer: null,
          floatBg: null,
          floatNoheader: false,
        },
      ],
      activePaneId: pid('%1'),
      activeWindowId: wid('@1'),
      totalWidth: 80,
      totalHeight: 24,
      sessionName: 'sess-$&-$$',
      focusRequest: '',
    };
    const model: TmuxClientModel = {
      committed: snapshot,
      ops: [],
      derived: snapshot,
      paneKeyOverrides: {},
    };
    actor.send({ type: 'TMUX_MODEL_UPDATE', model });
    actor.send({
      type: 'OPEN_COMMAND_PROMPT',
      prompt: '(#S/#W):',
      initial: '#W in #S',
      template: 'rename-window -- "%%%"',
    });
    const mode = actor.getSnapshot().context.commandMode;
    expect(mode?.prompt).toBe("(sess-$&-$$/win-$&-$'):");
    expect(mode?.input).toBe("win-$&-$' in sess-$&-$$");
    actor.stop();
  });
});
