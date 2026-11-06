/**
 * What the app reads off an op (`opTraits`), and the bindings tmux reports
 * read back as ops that render as the same strings.
 */

import { describe, it, expect } from 'vitest';
import { pinPrefix, TmuxOp, toTmuxCommand } from '../commands';
import { isMultiStep, isStructural } from '../opTraits';
import { parseCommandToOp } from '../store/parseCommand';
import { pid, wid } from '../../test/wire';

const S = '$TMUXY_DATA_DIR/bin/tmuxy';

describe('op classification', () => {
  it('flags the ops whose intermediate geometry must not animate', () => {
    expect(isMultiStep(TmuxOp.NewWindow())).toBe(true);
    expect(isMultiStep(TmuxOp.GroupClose({ paneId: pid('%1') }))).toBe(true);
    expect(isMultiStep(TmuxOp.Split({ direction: 'vertical' }))).toBe(false);
    const raw = (command: string) => isMultiStep(TmuxOp.RawCommand({ command }));
    // A raw command (a binding, an essentials alias expanded) by its marker.
    expect(raw(`run-shell "TMUXY_EFFECT=settle bash ${S}/float-create > /dev/null"`)).toBe(true);
    expect(raw(`run-shell "TMUXY_EFFECT=settle ${S}/pane-group next %3"`)).toBe(true);
    expect(raw(`run-shell "TMUXY_EFFECT=relist-windows bash ${S}/stack new %3"`)).toBe(false);
    expect(raw(`run-shell "${S}/pane-group join %3 %1 0"`)).toBe(false);
  });

  it('calls an op structural when the store predicts a layout for it, not a focus pin', () => {
    const move = TmuxOp.MoveWindow({
      windowId: wid('@1'),
      anchorId: wid('@2'),
      placement: 'after',
    });
    expect(isStructural(move)).toBe(true);
    expect(
      isStructural(TmuxOp.GroupSwitch({ clickedPaneId: pid('%1'), visiblePaneId: null })),
    ).toBe(true);
    expect(isStructural(TmuxOp.SelectPane({ paneId: pid('%1') }))).toBe(false);
  });
});

/**
 * A binding arrives as the string tmux reports; the op it parses to must
 * render back to that same string, or prediction and the wire would disagree
 * about what the key does.
 */
describe('short command forms parse to the same op as the long ones', () => {
  it('splitw and split-window are one op', () => {
    expect(parseCommandToOp('splitw -v')).toEqual(parseCommandToOp('split-window -v'));
    expect(parseCommandToOp('splitw -h')).toEqual(TmuxOp.Split({ direction: 'vertical' }));
  });
});

describe('binding strings round-trip through their op', () => {
  const bindings = [
    'split-window -h',
    'split-window -v',
    'select-pane -L',
    'select-pane -t %3',
    'select-pane -t :.+',
    'last-pane',
    'swap-pane -U',
    'swap-pane -D',
    'swap-pane',
    'swap-pane -d -s %1 -t %2',
    'join-pane',
    'select-pane -m',
    'select-pane -M',
    'break-pane',
    'kill-pane',
    'kill-pane -t %4',
    'resize-pane -Z',
    'resize-pane -t %4 -Z',
    "select-pane -t %4 -T 'title'",
    'paste-buffer -p',
    'copy-mode',
    'copy-mode -t %3',
    'new-window',
    'next-window',
    'previous-window',
    'last-window',
    'select-window -t @2',
    'select-window -t 3',
    "rename-window -- 'logs'",
    "rename-window -t @2 -- 'logs'",
    'select-layout tiled',
    'next-layout',
    'previous-layout',
    'kill-session',
    'tmuxy-nav-left',
    `run-shell "TMUXY_EFFECT=settle ${S}/pane-group next #{pane_id}"`,
    `run-shell "TMUXY_EFFECT=settle ${S}/pane-group prev %3"`,
    'command-prompt -I "#W" "rename-window -- \\"%%%\\""',
  ];

  // tmux reports an alias already expanded, so a key bound to `tmuxy-nav-left`
  // arrives as its body: the same op, which the client sends as the alias.
  it('the nav alias and its expanded body are one op', () => {
    expect(parseCommandToOp(`run-shell "bash ${S}/nav left #{pane_id}"`)).toEqual(
      parseCommandToOp('tmuxy-nav-left'),
    );
  });

  it.each(bindings)('%s', (binding) => {
    const op = parseCommandToOp(binding);
    expect(op._tag).not.toBe('RawCommand');
    expect(toTmuxCommand(op)).toBe(binding);
  });

  it('reads a prompt template the way list-keys prints it, escaped or as a block', () => {
    expect(parseCommandToOp('command-prompt -I "#W" "rename-window -- \\"%%%\\""')).toEqual(
      TmuxOp.CommandPrompt({ prompt: null, initial: '#W', template: 'rename-window -- "%%%"' }),
    );
    // tmux's own default `prefix ,`.
    expect(parseCommandToOp('command-prompt -I "#S" { rename-session "%%" }')).toEqual(
      TmuxOp.CommandPrompt({ prompt: null, initial: '#S', template: 'rename-session "%%"' }),
    );
  });

  it('reads the binding behind the pin keyboardActor prepends', () => {
    const pinned = `${pinPrefix(wid('@1'), pid('%2'))}split-window -h`;
    expect(parseCommandToOp(pinned)).toEqual(TmuxOp.Split({ direction: 'vertical' }));
    expect(parseCommandToOp(`${pinPrefix(wid('@1'), null)}new-window`)).toEqual(TmuxOp.NewWindow());
  });

  it('reads the config aliases as the ops they expand to', () => {
    expect(parseCommandToOp('tmuxy-nav-left')).toEqual(
      TmuxOp.Navigate({ direction: 'L', script: true }),
    );
    expect(parseCommandToOp('tmuxy-pane-group-next')).toEqual(
      TmuxOp.GroupStep({ direction: 'next', paneId: null }),
    );
  });

  it('keeps what it cannot name as a raw command', () => {
    // `display-message` is tmux's to run, so tmux expands its formats and
    // answers with a `%message` the snackbar shows.
    for (const command of [
      'choose-tree',
      'resize-pane -L 5',
      'display-message -p "#S"',
      "display-message 'Config reloaded!'",
    ]) {
      expect(parseCommandToOp(command)).toEqual(TmuxOp.RawCommand({ command }));
    }
  });
});
