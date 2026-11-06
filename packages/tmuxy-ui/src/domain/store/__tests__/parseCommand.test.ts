import { describe, it, expect } from 'vitest';
import {
  boundAction,
  commandListParts,
  commandWords,
  isLayoutCommand,
  runShellScript,
  stripPin,
  tabPosition,
} from '../parseCommand';
import { pinPrefix } from '../../commands';
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
    });
    expect(runShellScript('run-shell -b "float-create"')).toEqual({
      name: 'float-create',
      bundled: false,
      args: [],
    });
    expect(runShellScript('split-window -h')).toBeNull();
  });
});

describe('isLayoutCommand', () => {
  it('finds a layout verb in any command of a list', () => {
    expect(isLayoutCommand('select-layout -t @1 tiled')).toBe(true);
    expect(isLayoutCommand('kill-pane \\; nextl')).toBe(true);
    expect(isLayoutCommand('split-window -h')).toBe(false);
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
