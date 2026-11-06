import { describe, expect, it } from 'vitest';
import { pid, wid } from '../../../../test/wire';
import { modelPane, modelUpdate, modelWindow } from '../../../../test/model';
import { startApp } from '../../../../test/app';
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
    const actor = startApp();
    actor.send(
      modelUpdate(
        [modelPane(pid('%1'), wid('@1'), { height: 23, y: 1, active: true })],
        [modelWindow(wid('@1'), 0, { name: "win-$&-$'", active: true })],
        { paneId: pid('%1'), windowId: wid('@1') },
        { sessionName: 'sess-$&-$$' },
      ),
    );
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
