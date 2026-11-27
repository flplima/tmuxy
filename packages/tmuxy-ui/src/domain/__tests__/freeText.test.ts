/**
 * Free text where a tmux command takes an operand is read as flags when it
 * starts with a dash and no `--` comes before it: tmux refuses the command
 * ("unknown flag -1") and the paste, the typed text or the new name is lost.
 *
 * Every op goes through a model of tmux's parser (`test/tmuxArgs.ts`) with
 * dash-led text in each field that holds free text, and the text must come
 * back, byte for byte, from where tmux finds it. The table wants a row per
 * `TmuxOp` tag, and the row of an op with a string field must say, field by
 * field, where tmux finds that string or why it never holds free text: a new
 * op cannot leave its text out without saying so.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  renameSessionPrompt,
  renameWindowPrompt,
  TmuxOp,
  toTmuxCommand,
  type TmuxOpOf,
} from '../commands';
import { asciiJson, withoutControls } from '../commandHelpers';
import { flagOf, promptFilled, tmuxCommands, type TmuxCommand } from '../../test/tmuxArgs';
import { pid, wid } from '../../test/wire';

type Tag = TmuxOp['_tag'];
type Sent = ReadonlyArray<TmuxCommand>;

/** The fields of an op whose type admits any string: names, text, commands. */
type TextField<O> = {
  [K in keyof O]: K extends '_tag'
    ? never
    : string extends O[K]
      ? K
      : readonly string[] extends O[K]
        ? K
        : never;
}[keyof O];

/** Where tmux finds a field's text in what the op sent. */
type Found = (sent: Sent) => string;

type Row<O> = [TextField<O>] extends [never]
  ? { readonly op: O }
  : {
      /** The op with `text` in every field that has a `Found`. */
      readonly op: (text: string) => O;
      /** Each text field: where tmux finds it, or why it never holds free text. */
      readonly fields: { readonly [K in TextField<O>]: Found | string };
      /** What the op makes of the text on purpose, when not the text itself. */
      readonly as?: (text: string) => string;
    };

const only = (sent: Sent, verb: string): TmuxCommand => {
  const found = sent.filter((c) => c.verb === verb);
  expect(found, `one ${verb} in ${JSON.stringify(sent)}`).toHaveLength(1);
  return found[0];
};
const operand = (cmd: TmuxCommand, n = 0): string => {
  const value = cmd.operands[n];
  if (typeof value !== 'string') throw new Error(`operand ${n} of ${cmd.verb} is not text`);
  return value;
};
const flag = (cmd: TmuxCommand, letter: string): string => {
  const value = flagOf(cmd, letter);
  if (typeof value !== 'string') throw new Error(`${cmd.verb} has no -${letter} argument`);
  return value;
};
/** A session named as a target (`=name`, `=name:`), as the name. */
const session = (target: string): string =>
  target.startsWith('=') ? target.slice(1).replace(/:$/, '') : target;

/** What `send-keys` typed: each `-l` literal, and a newline for each Enter. */
const typed = (sent: Sent): string =>
  sent
    .filter((c) => c.verb === 'send-keys')
    .map((c) => (flagOf(c, 'l') === null ? c.operands.join('') : c.operands.join(' ')))
    .map((keys) => (keys === 'Enter' ? '\n' : keys))
    .join('');
/** What `set-buffer` left in the buffer: the first chunk, then each one appended. */
const buffered = (sent: Sent): string =>
  sent
    .filter((c) => c.verb === 'set-buffer')
    .map((c, i) => {
      expect(flagOf(c, 'a') !== undefined).toBe(i > 0);
      return operand(c);
    })
    .join('');
const firstTarget = (sent: Sent): string => session(flag(sent[0], 't'));

const KEY_NAMES = 'key names the client formats (`C-c`, `Up`); a lone `-` is an operand to tmux';
const OWN_WORDS = "the client's own words, never what the user typed";

const ROWS = {
  Split: { op: TmuxOp.Split({ direction: 'vertical' }) },
  Navigate: { op: TmuxOp.Navigate({ direction: 'L', script: true }) },
  SelectPane: { op: TmuxOp.SelectPane({ paneId: pid('%1') }) },
  CyclePane: { op: TmuxOp.CyclePane({ windowId: wid('@1') }) },
  LastPane: { op: TmuxOp.LastPane() },
  Swap: {
    op: TmuxOp.Swap({ sourcePaneId: pid('%1'), targetPaneId: pid('%2'), keepFocus: true }),
  },
  SwapAdjacent: { op: TmuxOp.SwapAdjacent({ direction: 'U' }) },
  SwapMarked: { op: TmuxOp.SwapMarked() },
  JoinMarked: { op: TmuxOp.JoinMarked() },
  MarkPane: { op: TmuxOp.MarkPane({ marked: true }) },
  BreakPane: { op: TmuxOp.BreakPane({ paneId: pid('%1') }) },
  JoinPane: { op: TmuxOp.JoinPane({ paneId: pid('%1'), windowId: wid('@2') }) },
  KillPane: { op: TmuxOp.KillPane({ paneId: pid('%1') }) },
  ZoomToggle: { op: TmuxOp.ZoomToggle({ paneId: pid('%1') }) },
  ResizePanes: {
    op: TmuxOp.ResizePanes({ steps: [{ paneId: pid('%1'), direction: 'L', cells: 3 }] }),
  },
  // A flag's own argument: tmux takes the next word whole, a dash and all.
  SetPaneTitle: {
    op: (text) => TmuxOp.SetPaneTitle({ paneId: pid('%1'), title: text }),
    fields: { title: (sent) => flag(only(sent, 'select-pane'), 'T') },
  },
  ClearPane: { op: TmuxOp.ClearPane() },
  PasteBuffer: { op: TmuxOp.PasteBuffer() },
  SendKeys: {
    op: (text) => TmuxOp.SendKeys({ target: text, keys: 'C-c' }),
    fields: { target: firstTarget, keys: KEY_NAMES },
  },
  SendText: {
    op: (text) => TmuxOp.SendText({ target: text, text }),
    fields: { target: firstTarget, text: typed },
  },
  PasteText: {
    op: (text) => TmuxOp.PasteText({ target: text, text }),
    fields: {
      target: (sent) => session(flag(only(sent, 'paste-buffer'), 't')),
      text: buffered,
    },
    as: withoutControls,
  },
  InterruptOrEof: { op: TmuxOp.InterruptOrEof({ paneId: pid('%1') }) },
  SendPreviewLine: {
    op: (text) => TmuxOp.SendPreviewLine({ paneId: pid('%1'), json: text }),
    fields: { json: buffered },
    as: (text) => `${asciiJson(text)}\n`,
  },
  SendMouse: {
    op: TmuxOp.SendMouse({
      paneId: pid('%1'),
      reports: [{ button: 0, x: 1, y: 1, release: false }],
    }),
  },
  EnterCopyMode: { op: TmuxOp.EnterCopyMode({ paneId: pid('%1') }) },
  CancelCopyMode: { op: TmuxOp.CancelCopyMode({ paneId: pid('%1') }) },
  AnswerAsk: {
    op: (text) => TmuxOp.AnswerAsk({ paneId: pid('%1'), token: 'f00d', answer: text }),
    fields: {
      token: 'a token the server minted, hex',
      // The option's value comes after its name: tmux has read its options by then.
      answer: (sent) => operand(sent[1], 1).replace(/^f00d:/, ''),
    },
  },
  AnswerOffer: {
    op: (text) => TmuxOp.AnswerOffer({ paneId: pid('%1'), command: text, run: true }),
    // Typed, then the Enter that runs it.
    fields: { command: (sent) => typed(sent).replace(/\n$/, '') },
  },
  ClearPaneState: { op: TmuxOp.ClearPaneState({ paneId: pid('%1') }) },
  NewWindow: { op: TmuxOp.NewWindow() },
  SelectWindow: { op: TmuxOp.SelectWindow({ target: wid('@1') }) },
  LastWindow: { op: TmuxOp.LastWindow() },
  KillWindow: { op: TmuxOp.KillWindow({ windowId: wid('@1') }) },
  RenameWindow: {
    op: (text) => TmuxOp.RenameWindow({ target: wid('@1'), name: text }),
    fields: { name: (sent) => operand(only(sent, 'rename-window')) },
  },
  MoveWindow: {
    op: TmuxOp.MoveWindow({ windowId: wid('@1'), anchorId: wid('@2'), placement: 'before' }),
  },
  SelectLayout: {
    op: () => TmuxOp.SelectLayout({ layout: 'tiled' }),
    fields: { layout: "a preset's name or `next`/`previous`: the menu's own words" },
  },
  SetWindowTag: {
    op: () => TmuxOp.SetWindowTag({ windowId: wid('@1'), tag: 'sidebar-rows', value: '12' }),
    fields: { value: 'a count or a word the client writes, after the option name' },
  },
  GroupAdd: { op: TmuxOp.GroupAdd({ pane: { paneId: pid('%1'), width: 80, height: 24 } }) },
  GroupClose: { op: TmuxOp.GroupClose({ paneId: pid('%1') }) },
  ReviveAgent: { op: TmuxOp.ReviveAgent({ paneId: pid('%1') }) },
  CheckRevive: { op: TmuxOp.CheckRevive({ paneId: pid('%1') }) },
  GroupSwitch: { op: TmuxOp.GroupSwitch({ clickedPaneId: pid('%1'), visiblePaneId: pid('%2') }) },
  GroupStep: { op: TmuxOp.GroupStep({ direction: 'next', paneId: pid('%1') }) },
  GroupMove: { op: TmuxOp.GroupMove({ paneId: pid('%1'), index: 2 }) },
  GroupJoin: { op: TmuxOp.GroupJoin({ paneId: pid('%1'), anchorPaneId: pid('%2'), index: 0 }) },
  GroupLeave: { op: TmuxOp.GroupLeave({ paneId: pid('%1'), to: { kind: 'tab' } }) },
  OpenFloat: {
    op: () => TmuxOp.OpenFloat({ command: ['tmuxy', 'session', 'connect'], splitFrom: pid('%1') }),
    fields: { command: `${OWN_WORDS}, in a shell line that starts with the CLI's path` },
  },
  OpenSidebar: { op: TmuxOp.OpenSidebar({ side: 'left', splitFrom: pid('%1') }) },
  // `-s` and `-t` take the next word whole.
  NewSession: {
    op: (text) => TmuxOp.NewSession({ name: text }),
    fields: { name: (sent) => flag(only(sent, 'new-session'), 's') },
  },
  KillSession: {
    op: (text) => TmuxOp.KillSession({ name: text }),
    fields: { name: firstTarget },
  },
  SwitchClient: {
    op: (text) => TmuxOp.SwitchClient({ session: text }),
    fields: { session: firstTarget },
  },
  RenameSession: {
    op: (text) => TmuxOp.RenameSession({ session: text, name: text }),
    fields: {
      session: firstTarget,
      name: (sent) => operand(only(sent, 'rename-session')),
    },
  },
  SourceConfig: { op: TmuxOp.SourceConfig() },
  ClearFocusRequest: {
    op: (text) => TmuxOp.ClearFocusRequest({ session: text }),
    fields: { session: firstTarget },
  },
  AnnounceCellSize: {
    op: () => TmuxOp.AnnounceCellSize({ size: '9x24' }),
    fields: { size: 'a size the client measured (`formatCellPx`): digits, a dot and an x' },
  },
  PluginAction: {
    op: () =>
      TmuxOp.PluginAction({ plugin: 'git', action: 'blame', paneId: pid('%1'), token: null }),
    fields: {
      plugin: 'checked against the alphabet the server accepts, which has no leading dash',
      action: 'checked against the alphabet the server accepts, which has no leading dash',
      token: 'checked to be 32 hex digits',
    },
  },
  // What the user types fills `%%%`: the rename prompts' own test below.
  CommandPrompt: {
    op: () => renameWindowPrompt() as TmuxOpOf<'CommandPrompt'>,
    fields: { prompt: OWN_WORDS, initial: OWN_WORDS, template: OWN_WORDS },
  },
  RawCommand: {
    op: () => TmuxOp.RawCommand({ command: 'display-message -p x' }),
    fields: { command: 'a string the client did not originate, sent as it came' },
  },
} satisfies { readonly [T in Tag]: Row<TmuxOpOf<T>> };

/** Text that starts with a dash: alone, as a flag tmux knows, past one chunk (500 characters). */
const DASHED = [
  '-1',
  '-',
  '--',
  '-a -b x',
  '--help',
  '-t %1',
  "-it's",
  '-1\n-2',
  '-"q" $x #{y} ; a\\;b ~',
  `-${'x'.repeat(499)}-a -b`,
];

type AnyRow =
  | { op: TmuxOp }
  | { op: (text: string) => TmuxOp; fields: object; as?: (t: string) => string };

/** `row`'s op with `text`, read as tmux reads it; each text field found where it should be. */
function check(row: AnyRow, text: string): void {
  const op = typeof row.op === 'function' ? row.op(text) : row.op;
  const sent = tmuxCommands(toTmuxCommand(op));
  if (!('fields' in row)) return;
  const wanted = row.as ? row.as(text) : text;
  for (const [field, found] of Object.entries(row.fields)) {
    if (typeof found === 'function') expect(found(sent), field).toBe(wanted);
  }
}

const TAGS = Object.keys(ROWS) as Tag[];

describe('free text that starts with a dash', () => {
  it.each(TAGS)('%s: tmux reads every command it sends, and its text comes back', (tag) => {
    for (const text of DASHED) check(ROWS[tag], text);
  });

  it('holds for any text that starts with a dash, any length', () => {
    const alphabet = fc.constantFrom(
      '-',
      '-',
      '-',
      'a',
      '1',
      ' ',
      '\n',
      "'",
      '"',
      '\\',
      '$',
      ';',
      '#',
      '%',
      'é',
    );
    const text = fc.array(alphabet, { maxLength: 1100 }).map((chars) => `-${chars.join('')}`);
    fc.assert(
      fc.property(fc.constantFrom(...TAGS), text, (tag, t) => check(ROWS[tag], t)),
      { numRuns: 300 },
    );
  });

  it('a name typed at a rename prompt that starts with a dash is the new name', () => {
    for (const [prompt, verb] of [
      [renameWindowPrompt(), 'rename-window'],
      [renameSessionPrompt(), 'rename-session'],
    ] as const) {
      const [cmd] = tmuxCommands(toTmuxCommand(prompt));
      for (const name of DASHED.filter((t) => !t.includes('\n'))) {
        const [renamed] = tmuxCommands(promptFilled(operand(cmd), name));
        expect(renamed.verb).toBe(verb);
        expect(operand(renamed)).toBe(name);
      }
    }
  });

  it('is what the model reads as tmux does: a dash-led operand with no `--` is refused', () => {
    expect(() => tmuxCommands('set-buffer -b tmuxy-paste "-1"')).toThrow('unknown flag -1');
    expect(() => tmuxCommands("rename-window -t @1 '-t'")).toThrow('-t expects an argument');
    expect(tmuxCommands("set-buffer -a -b tmuxy-paste -- '-a'")[0].operands).toEqual(['-a']);
    expect(tmuxCommands('send-keys -t %1 -')[0].operands).toEqual(['-']);
    expect(flagOf(tmuxCommands("select-pane -t %1 -T '-1'")[0], 'T')).toBe('-1');
  });
});
