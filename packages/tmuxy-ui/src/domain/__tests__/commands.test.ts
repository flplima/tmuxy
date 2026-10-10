/**
 * `toTmuxCommand` is the only place the UI spells tmux syntax, so every op's
 * exact string is pinned here — what reaches tmux (and what the backend's
 * router and the demo engine pattern-match) cannot change without a test
 * saying so.
 */

import { describe, it, expect } from 'vitest';
import {
  isLayoutChange,
  isMultiStep,
  pinPrefix,
  quote,
  renameSessionPrompt,
  renameWindowPrompt,
  TmuxOp,
  toTmuxCommand,
} from '../commands';
import { parseCommandToOp } from '../store/parseCommand';
import { pid, wid } from '../../test/wire';

const S = '$HOME/.config/tmuxy/bin/tmuxy';

const cases: Array<[TmuxOp, string]> = [
  // Panes
  [TmuxOp.Split({ direction: 'vertical' }), 'split-window -h'],
  [TmuxOp.Split({ direction: 'horizontal' }), 'split-window -v'],
  [TmuxOp.Navigate({ direction: 'L', script: false }), 'select-pane -L'],
  [TmuxOp.Navigate({ direction: 'R', script: true }), `run-shell "bash ${S}/nav right #{pane_id}"`],
  [TmuxOp.SelectPane({ paneId: pid('%3') }), 'select-pane -t %3'],
  [TmuxOp.CyclePane({ windowId: null }), 'select-pane -t :.+'],
  [TmuxOp.CyclePane({ windowId: wid('@2') }), 'select-pane -t @2.+'],
  [TmuxOp.LastPane(), 'last-pane'],
  [
    TmuxOp.Swap({ sourcePaneId: pid('%1'), targetPaneId: pid('%2'), keepFocus: false }),
    'swap-pane -s %1 -t %2',
  ],
  [
    TmuxOp.Swap({ sourcePaneId: pid('%1'), targetPaneId: pid('%2'), keepFocus: true }),
    'swap-pane -d -s %1 -t %2',
  ],
  [TmuxOp.SwapAdjacent({ direction: 'U' }), 'swap-pane -U'],
  [TmuxOp.SwapAdjacent({ direction: 'D' }), 'swap-pane -D'],
  [TmuxOp.SwapMarked(), 'swap-pane'],
  [TmuxOp.JoinMarked(), 'join-pane'],
  [TmuxOp.MarkPane({ marked: true }), 'select-pane -m'],
  [TmuxOp.MarkPane({ marked: false }), 'select-pane -M'],
  [TmuxOp.BreakPane({ paneId: null }), 'break-pane'],
  [TmuxOp.BreakPane({ paneId: pid('%4') }), 'break-pane -s %4'],
  [TmuxOp.JoinPane({ paneId: pid('%4'), windowId: wid('@1') }), 'join-pane -s %4 -t @1'],
  [TmuxOp.KillPane({ paneId: null }), 'kill-pane'],
  [TmuxOp.KillPane({ paneId: pid('%4') }), 'kill-pane -t %4'],
  [TmuxOp.ZoomToggle({ paneId: null }), 'resize-pane -Z'],
  [TmuxOp.ZoomToggle({ paneId: pid('%4') }), 'resize-pane -t %4 -Z'],
  [
    TmuxOp.ResizePanes({
      steps: [
        { paneId: pid('%1'), direction: 'R', cells: 3 },
        { paneId: pid('%2'), direction: 'U', cells: 1 },
      ],
    }),
    'resize-pane -t %1 -R 3 \\; resize-pane -t %2 -U 1',
  ],
  [TmuxOp.SetPaneTitle({ paneId: pid('%4'), title: "Bob's" }), "select-pane -t %4 -T 'Bob'\\''s'"],
  [TmuxOp.ClearPane(), 'send-keys -R \\; clear-history'],
  [TmuxOp.PasteBuffer(), 'paste-buffer'],
  [TmuxOp.SendKeys({ target: pid('%3'), keys: 'C-c' }), 'send-keys -t %3 C-c'],
  [TmuxOp.SendKeys({ target: 'main', keys: 'Up' }), 'send-keys -t main Up'],
  [TmuxOp.SendText({ target: pid('%3'), text: "it's" }), "send-keys -t %3 -l 'it'\\''s'"],
  [
    TmuxOp.SendMouse({ paneId: pid('%3'), button: 0, x: 5, y: 2, release: false }),
    'send-keys -t %3 -H 1b 5b 3c 30 3b 35 3b 32 4d',
  ],
  [
    TmuxOp.SendMouse({ paneId: pid('%3'), button: 64, x: 1, y: 1, release: true }),
    'send-keys -t %3 -H 1b 5b 3c 36 34 3b 31 3b 31 6d',
  ],
  [TmuxOp.EnterCopyMode({ paneId: null }), 'copy-mode'],
  [TmuxOp.EnterCopyMode({ paneId: pid('%3') }), 'copy-mode -t %3'],
  [TmuxOp.CancelCopyMode({ paneId: pid('%3') }), 'send-keys -t %3 -X cancel'],
  [
    TmuxOp.AnswerAsk({ paneId: pid('%3'), token: 't1', answer: 'yes' }),
    "set-option -pu -t %3 @tmuxy-ask \\; set-option -p -t %3 @tmuxy-ask-answer 't1:yes'",
  ],

  // Windows
  [TmuxOp.NewWindow(), 'new-window'],
  [TmuxOp.SelectWindow({ target: wid('@2') }), 'select-window -t @2'],
  [TmuxOp.SelectWindow({ target: 3 }), 'select-window -t 3'],
  [TmuxOp.SelectWindow({ target: 'next' }), 'next-window'],
  [TmuxOp.SelectWindow({ target: 'previous' }), 'previous-window'],
  [TmuxOp.LastWindow(), 'last-window'],
  [TmuxOp.KillWindow({ windowId: null }), 'kill-window'],
  [TmuxOp.KillWindow({ windowId: wid('@2') }), 'kill-window -t @2'],
  [TmuxOp.RenameWindow({ target: null, name: 'logs' }), "rename-window -- 'logs'"],
  [TmuxOp.RenameWindow({ target: wid('@2'), name: "a'b" }), "rename-window -t @2 -- 'a'\\''b'"],
  [
    TmuxOp.MoveWindow({ windowId: wid('@3'), anchorId: wid('@1'), placement: 'before' }),
    'move-window -b -s @3 -t @1',
  ],
  [
    TmuxOp.MoveWindow({ windowId: wid('@3'), anchorId: wid('@1'), placement: 'after' }),
    'move-window -a -s @3 -t @1',
  ],
  [TmuxOp.SelectLayout({ layout: 'tiled' }), 'select-layout tiled'],
  [TmuxOp.SelectLayout({ layout: 'next' }), 'next-layout'],
  [TmuxOp.SelectLayout({ layout: 'previous' }), 'previous-layout'],
  [
    TmuxOp.SetWindowTag({ windowId: wid('@2'), tag: 'collapsible', value: '1' }),
    'set-option -w -t @2 @tmuxy-collapsible 1',
  ],
  [
    TmuxOp.SetWindowTag({ windowId: wid('@2'), tag: 'sidebar-hidden', value: null }),
    'set-option -u -w -t @2 @tmuxy-sidebar-hidden',
  ],

  // Pane groups
  [
    TmuxOp.GroupAdd({ pane: null }),
    `run-shell "${S}/pane-group-add #{pane_id} #{pane_width} #{pane_height}"`,
  ],
  [
    TmuxOp.GroupAdd({ pane: { paneId: pid('%3'), width: 80, height: 24 } }),
    `run-shell "${S}/pane-group-add %3 80 24"`,
  ],
  [TmuxOp.GroupClose({ paneId: pid('%3') }), `run-shell "${S}/pane-group-close %3"`],
  [
    TmuxOp.GroupSwitch({ clickedPaneId: pid('%3'), visiblePaneId: pid('%1') }),
    `run-shell "${S}/pane-group-switch %3"`,
  ],
  [
    TmuxOp.GroupStep({ direction: 'next', paneId: pid('%3') }),
    `run-shell "${S}/pane-group-next %3"`,
  ],
  [
    TmuxOp.GroupStep({ direction: 'prev', paneId: null }),
    `run-shell "${S}/pane-group-prev #{pane_id}"`,
  ],
  [TmuxOp.GroupMove({ paneId: pid('%3'), index: 2 }), `run-shell "${S}/pane-group-move %3 2"`],
  [
    TmuxOp.GroupJoin({ paneId: pid('%3'), anchorPaneId: pid('%1'), index: 0 }),
    `run-shell "${S}/pane-group-join %3 %1 0"`,
  ],
  [
    TmuxOp.GroupLeave({ paneId: pid('%3'), to: { kind: 'tab' } }),
    `run-shell "${S}/pane-group-leave %3 --tab"`,
  ],
  [
    TmuxOp.GroupLeave({
      paneId: pid('%3'),
      to: { kind: 'beside', target: pid('%1'), side: 'left' },
    }),
    `run-shell "${S}/pane-group-leave %3 --beside %1 left"`,
  ],
  [
    TmuxOp.GroupLeave({
      paneId: pid('%3'),
      to: { kind: 'beside', target: wid('@2'), side: 'right' },
    }),
    `run-shell "${S}/pane-group-leave %3 --beside @2 right"`,
  ],

  // Chrome windows
  [
    TmuxOp.OpenFloat({ name: 'connect', run: 'tmuxy connect', index: 3, splitFrom: pid('%1') }),
    "split-window -t %1 'tmuxy connect' \\; break-pane -d -n connect -t :3 \\; " +
      'set-option -w -t :3 @tmuxy-window-type float',
  ],
  [
    TmuxOp.OpenSidebar({ side: 'left', splitFrom: pid('%1') }),
    "split-window -t %1 'tmuxy widget tree' \\; break-pane -d -n __sidebar-left \\; " +
      'set-option -w -t :__sidebar-left @tmuxy-window-type sidebar-left',
  ],
  [
    TmuxOp.OpenSidebar({ side: 'right', splitFrom: null }),
    'split-window \\; break-pane -d -n __sidebar-right \\; ' +
      'set-option -w -t :__sidebar-right @tmuxy-window-type sidebar-right',
  ],

  // Sessions
  [TmuxOp.NewSession({ name: 'tmuxy_17' }), 'new-session -d -s tmuxy_17'],
  [TmuxOp.KillSession({ name: null }), 'kill-session'],
  [TmuxOp.KillSession({ name: 'my work' }), "kill-session -t 'my work'"],
  [TmuxOp.SwitchClient({ session: 'my work' }), "switch-client -t 'my work'"],
  [TmuxOp.RenameSession({ session: 'work', name: 'play' }), "rename-session -t work -- 'play'"],
  [TmuxOp.SourceConfig(), 'source-file ~/.config/tmuxy/tmuxy.conf'],
  [TmuxOp.ClearFocusRequest({ session: 'tmuxy' }), 'set-option -u -t tmuxy @tmuxy-focus-request'],
  [TmuxOp.ClearSwitchRequest(), 'set-environment -g -u TMUXY_SWITCH_TO'],

  // Client-side
  [renameWindowPrompt(), 'command-prompt -I "#W" "rename-window -- \'%%\'"'],
  [renameSessionPrompt(), 'command-prompt -I "#S" "rename-session -- \'%%\'"'],
  [TmuxOp.DisplayMessage({ message: 'hi' }), "display-message 'hi'"],
  [TmuxOp.RawCommand({ command: 'choose-tree' }), 'choose-tree'],
];

describe('toTmuxCommand', () => {
  it.each(cases)('%o → %s', (op, command) => {
    expect(toTmuxCommand(op)).toBe(command);
  });

  it('types multi-line text line by line, so no line of it becomes a tmux command', () => {
    // Pane output a user selected and chose "Send keys" on.
    const text = "echo one\nrun-shell 'touch /tmp/pwned'\r\nlast";
    expect(toTmuxCommand(TmuxOp.SendText({ target: pid('%3'), text })).split('\n')).toEqual([
      "send-keys -t %3 -l 'echo one'",
      'send-keys -t %3 Enter',
      "send-keys -t %3 -l 'run-shell '\\''touch /tmp/pwned'\\'''",
      'send-keys -t %3 Enter',
      "send-keys -t %3 -l 'last'",
    ]);
  });

  it('splits a long line into chunks and keeps blank lines as Enter', () => {
    const text = `${'x'.repeat(1200)}\n\n`;
    expect(toTmuxCommand(TmuxOp.SendText({ target: pid('%1'), text })).split('\n')).toEqual([
      `send-keys -t %1 -l '${'x'.repeat(500)}'`,
      `send-keys -t %1 -l '${'x'.repeat(500)}'`,
      `send-keys -t %1 -l '${'x'.repeat(200)}'`,
      'send-keys -t %1 Enter',
      'send-keys -t %1 Enter',
    ]);
  });
});

describe('AnswerAsk', () => {
  const answer = (choice: string) =>
    toTmuxCommand(TmuxOp.AnswerAsk({ paneId: pid('%3'), token: '3-4821', answer: choice }));

  it('clears the question before recording the answer', () => {
    // The overlay is what the user is looking at: it comes down as they
    // choose, not once the waiting CLI gets around to sending the keys.
    const command = answer('yes');
    expect(command.indexOf('-pu -t %3 @tmuxy-ask')).toBeLessThan(
      command.indexOf('@tmuxy-ask-answer'),
    );
  });

  it('pins the answer to the question that was on screen', () => {
    expect(answer('yes')).toContain("@tmuxy-ask-answer '3-4821:yes'");
    expect(answer('no')).toContain("@tmuxy-ask-answer '3-4821:no'");
  });
});

describe('quote', () => {
  it('single-quotes text, closing and reopening around a quote', () => {
    expect(quote('a b')).toBe("'a b'");
    expect(quote("it's")).toBe("'it'\\''s'");
  });
});

describe('pinPrefix', () => {
  it('pins the window, then the pane', () => {
    expect(pinPrefix(wid('@1'), pid('%2'))).toBe('select-window -t @1 \\; select-pane -t %2 \\; ');
    expect(pinPrefix(wid('@1'), null)).toBe('select-window -t @1 \\; ');
    expect(pinPrefix(null, pid('%2'))).toBe('select-pane -t %2 \\; ');
    expect(pinPrefix(null, null)).toBe('');
  });
});

describe('op classification', () => {
  it('flags the ops whose intermediate geometry must not animate', () => {
    expect(isMultiStep(TmuxOp.NewWindow())).toBe(true);
    expect(isMultiStep(TmuxOp.GroupClose({ paneId: pid('%1') }))).toBe(true);
    expect(isMultiStep(TmuxOp.Split({ direction: 'vertical' }))).toBe(false);
    expect(isMultiStep(TmuxOp.RawCommand({ command: 'run-shell "float-create"' }))).toBe(true);
  });

  it('flags layout changes, typed or raw', () => {
    expect(isLayoutChange(TmuxOp.SelectLayout({ layout: 'tiled' }))).toBe(true);
    expect(isLayoutChange(TmuxOp.RawCommand({ command: 'select-layout -t @1 tiled' }))).toBe(true);
    expect(isLayoutChange(TmuxOp.Split({ direction: 'vertical' }))).toBe(false);
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
    'paste-buffer',
    'copy-mode',
    'copy-mode -t %3',
    'new-window',
    'next-window',
    'previous-window',
    'last-window',
    'select-window -t @2',
    'select-window -t 3',
    'kill-window',
    'kill-window -t @2',
    "rename-window -- 'logs'",
    "rename-window -t @2 -- 'logs'",
    'select-layout tiled',
    'next-layout',
    'previous-layout',
    'kill-session',
    `run-shell "bash ${S}/nav left #{pane_id}"`,
    `run-shell "${S}/pane-group-next #{pane_id}"`,
    `run-shell "${S}/pane-group-prev %3"`,
    'command-prompt -I "#W" "rename-window -- \'%%\'"',
    "display-message 'Config reloaded!'",
  ];

  it.each(bindings)('%s', (binding) => {
    const op = parseCommandToOp(binding);
    expect(op._tag).not.toBe('RawCommand');
    expect(toTmuxCommand(op)).toBe(binding);
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
    for (const command of ['choose-tree', 'resize-pane -L 5', 'display-message -p "#S"']) {
      expect(parseCommandToOp(command)).toEqual(TmuxOp.RawCommand({ command }));
    }
  });
});
