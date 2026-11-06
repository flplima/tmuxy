import { describe, it, expect } from 'vitest';
import {
  boundAction,
  commandListParts,
  commandWords,
  parseCommandToOp,
  runShellScript,
  stripPin,
  tabPosition,
} from '../parseCommand';
import { pinPrefix, TmuxOp, toTmuxCommand } from '../../commands';
import { pid, wid } from '../../../test/wire';

const S = '$TMUXY_DATA_DIR/bin/tmuxy';

describe('commandWords', () => {
  it('reads quotes and blocks as one word each, as tmux does', () => {
    expect(commandWords(`display -p 'a b' "c \\"d\\"" { e f }`)).toEqual([
      'display',
      '-p',
      'a b',
      'c "d"',
      'e f',
    ]);
  });
});

describe('commandListParts', () => {
  it('splits a list on bare separators only', () => {
    expect(commandListParts('kill-pane \\; display "a \\; b" ; last')).toEqual([
      'kill-pane',
      'display "a \\; b"',
      'last',
    ]);
  });
});

describe('stripPin', () => {
  it('takes off exactly what pinPrefix puts on', () => {
    const binding = 'split-window -h';
    expect(stripPin(pinPrefix(wid('@1'), pid('%2')) + binding)).toBe(binding);
    expect(stripPin(pinPrefix(null, pid('%2')) + binding)).toBe(binding);
    expect(stripPin(pinPrefix(wid('@1'), null) + binding)).toBe(binding);
  });

  it('leaves a binding that only selects a pane alone', () => {
    expect(stripPin('select-pane -t %2')).toBe('select-pane -t %2');
  });
});

describe('runShellScript', () => {
  it('names the script a run-shell runs, quoted or behind bash', () => {
    expect(runShellScript(`run-shell "bash '${S}/pane-group' next %3"`)).toEqual({
      name: 'pane-group',
      bundled: true,
      args: ['next', '%3'],
      effect: null,
    });
    expect(runShellScript('run-shell -b "float-create"')).toEqual({
      name: 'float-create',
      bundled: false,
      args: [],
      effect: null,
    });
    expect(
      runShellScript(`run-shell "TMUXY_EFFECT=settle bash ${S}/float-create > /dev/null"`),
    ).toMatchObject({ name: 'float-create', effect: 'settle' });
    expect(runShellScript('split-window -h')).toBeNull();
  });
});

describe('tabPosition', () => {
  it('reads the tab table digits, pinned or not, and nothing else', () => {
    expect(tabPosition('select-window -t 3')).toBe(3);
    expect(tabPosition(pinPrefix(wid('@1'), pid('%2')) + 'select-window -t 3')).toBe(3);
    expect(tabPosition('select-window -t @3')).toBeNull();
    expect(tabPosition('select-window -t 3 \\; kill-pane')).toBeNull();
  });
});

describe('boundAction', () => {
  it('unwraps confirm-before with its flags and a quoted command', () => {
    expect(boundAction('confirm-before -y -p "really? (y/n)" "kill-session"')).toBe('kill-session');
    expect(boundAction("confirm-before -p 'go?' kill-server")).toBe('kill-server');
  });

  it('drops the directory a split or a new window starts in, however it is quoted', () => {
    expect(boundAction("split-window -h -c '#{pane_current_path}'")).toBe('split-window -h');
    expect(boundAction('new-window -c #{pane_current_path}')).toBe('new-window');
  });

  it('keeps the rest of a command it takes the directory out of', () => {
    expect(boundAction('new-window -c "#{pane_current_path}" -n x')).toBe('new-window -n x');
  });
});

/**
 * A binding arrives as the string tmux reports; the op it parses to must
 * render back to that same string, or prediction and the wire would disagree
 * about what the key does.
 */
describe('parseCommandToOp', () => {
  it.each([
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
  ])('%s round-trips through its op', (binding) => {
    const op = parseCommandToOp(binding);
    expect(op._tag).not.toBe('RawCommand');
    expect(toTmuxCommand(op)).toBe(binding);
  });

  // tmux reports what a key runs, not what the config wrote: an alias comes
  // already expanded (into an absolute path, or a relative one from configs
  // older than v0.0.6), a short form as written, a `-c` directory as given.
  // Each reads as the op the canonical spelling does.
  it.each([
    ['splitw -h', 'split-window -h'],
    ['split-window -v -c "#{pane_current_path}"', 'split-window -v'],
    [`run-shell "bash ${S}/nav left #{pane_id}"`, 'tmuxy-nav-left'],
    ['run-shell "bash /home/u/.local/share/tmuxy/bin/tmuxy/nav down #{pane_id}"', 'tmuxy-nav-down'],
    ['run-shell "bash bin/tmuxy/nav up"', 'tmuxy-nav-up'],
    ['rename-window -t @1 newname', "rename-window -t @1 -- 'newname'"],
  ])('%s reads as %s', (reported, canonical) => {
    expect(parseCommandToOp(reported)).toEqual(parseCommandToOp(canonical));
  });

  it('reads a window kill, current or by id', () => {
    expect(parseCommandToOp('kill-window')).toEqual(TmuxOp.KillWindow({ windowId: null }));
    expect(parseCommandToOp('kill-window -t @2')).toEqual(
      TmuxOp.KillWindow({ windowId: wid('@2') }),
    );
  });

  it('reads the config aliases as the ops they expand to', () => {
    expect(parseCommandToOp('tmuxy-nav-left')).toEqual(
      TmuxOp.Navigate({ direction: 'L', script: true }),
    );
    expect(parseCommandToOp('tmuxy-pane-group-next')).toEqual(
      TmuxOp.GroupStep({ direction: 'next', paneId: null }),
    );
  });

  // Every bound command is sent behind the window and pane pin, so tmux's
  // active pane matches the client's before the binding runs; the op is the
  // binding after the pin.
  it.each([
    [`${pinPrefix(wid('@1'), pid('%2'))}split-window -h`, 'split-window -h'],
    [`${pinPrefix(null, pid('%2'))}swap-pane -s %1 -t %2`, 'swap-pane -s %1 -t %2'],
    [`${pinPrefix(wid('@1'), null)}new-window`, 'new-window'],
    ['select-pane -t %0 \\; tmuxy-nav-right', 'tmuxy-nav-right'],
    [
      'select-window -t @2 \\; select-pane -t %0 \\; run-shell "bash /x/bin/tmuxy/nav right #{pane_id}"',
      'tmuxy-nav-right',
    ],
    ['select-pane -t %0 \\; kill-pane', 'kill-pane'],
  ])('reads the binding behind its pin: %s', (pinned, binding) => {
    expect(parseCommandToOp(pinned)).toEqual(parseCommandToOp(binding));
    expect(parseCommandToOp(pinned)._tag).not.toBe('RawCommand');
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

  // `display-message` is tmux's to run, so tmux expands its formats and
  // answers with a `%message` the snackbar shows. A window by index, a plain
  // resize and the nav script's next/prev have no geometry the client could
  // predict, so they stay tmux's too.
  it.each([
    'choose-tree',
    'resize-pane -L 5',
    'kill-window -t :2',
    'display-message -p "#S"',
    "display-message 'Config reloaded!'",
    'run-shell "bash /home/u/.local/share/tmuxy/bin/tmuxy/nav prev #{pane_id}"',
  ])('keeps %s as a raw command', (command) => {
    expect(parseCommandToOp(command)).toEqual(TmuxOp.RawCommand({ command }));
  });
});
