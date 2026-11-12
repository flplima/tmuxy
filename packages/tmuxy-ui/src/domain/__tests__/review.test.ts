import { describe, it, expect } from 'vitest';
import { isAgentPane, namedTarget, reviewPrompt, sendRefusal, commentKey } from '../review';
import { reviewInto, REVIEW_REFUSED } from '../commandHelpers';
import { AGENT_TAKES_INPUT } from '../tmuxyConstants.gen';
import { modelPane } from '../../test/model';
import { pid, wid } from '../../test/wire';

describe('a review', () => {
  it('is one numbered prompt: where each comment is, what it says, and the line it is about', () => {
    const prompt = reviewPrompt('shop', 'branch', [
      {
        path: 'src/cart.js',
        side: 'new',
        line: 3,
        code: '  for (const item of items) sum += item.price * item.quantity;',
        body: 'Check the quantity\nis never negative.',
      },
      { path: 'README.md', side: 'old', line: 2, code: 'A tiny cart.', body: 'Keep this line.' },
    ]);
    expect(prompt).toBe(
      [
        "Review of the branch's changes in shop:",
        '',
        '1. src/cart.js:3 — Check the quantity is never negative.',
        '   > for (const item of items) sum += item.price * item.quantity;',
        '2. README.md:2 (removed line) — Keep this line.',
        '   > A tiny cart.',
      ].join('\n'),
    );
  });

  it('is keyed by file, side and line', () => {
    expect(commentKey('a.rs', 'new', 3)).not.toBe(commentKey('a.rs', 'old', 3));
    expect(commentKey('a.rs', 'new', 3)).not.toBe(commentKey('b.rs', 'new', 3));
  });

  /**
   * A pane whose agent waits at a question gets nothing: the prompt's first
   * line would be read as the answer, and the user never gave one.
   */
  it('is refused while the pane it goes to waits for an answer', () => {
    const agent = modelPane(pid('%3'), wid('@1'), { command: 'claude' });
    expect(sendRefusal(agent)).toBeNull();
    expect(sendRefusal({ ...agent, paneState: 'working' })).toBeNull();
    expect(sendRefusal({ ...agent, paneState: 'needs-input' })).toBe(
      '%3 is waiting for your answer: answer it first, nothing was sent',
    );
    expect(sendRefusal(undefined)).toBe('there is no agent in this tab to send it to');
  });

  it('goes to the pane `--to` named, read from the widget lines', () => {
    expect(namedTarget(['shop', 'to:%12'])).toBe('%12');
    expect(namedTarget(['shop'])).toBeNull();
    expect(namedTarget(['shop', 'to:%12; rm -rf'])).toBeNull();
  });

  /**
   * A shell runs each line it is given, and a quoted `   > code` line is a
   * redirection that empties a file: only an agent is typed to.
   */
  it('is never sent to a pane that runs no agent', () => {
    const shell = modelPane(pid('%4'), wid('@1'), { command: 'zsh' });
    expect(sendRefusal(shell)).toBe('%4 runs zsh, not an agent: nothing was sent');
    expect(isAgentPane({ command: 'codex' })).toBe(true);
    expect(isAgentPane({ command: '2.1.30' })).toBe(true);
    expect(isAgentPane({ command: 'python3.12' })).toBe(false);
  });

  /**
   * The client's check is as fresh as its last update: tmux checks again in
   * the same command list as the paste and the Enter, so no dialog can come
   * up between the check and the keys.
   */
  it('is pasted and entered only inside one tmux check of the agent', () => {
    const lines = reviewInto(pid('%3'), 'Review:\n1. a.rs:2 — x').split('\n');
    expect(lines.slice(0, -1).every((line) => line.startsWith('set-buffer '))).toBe(true);
    expect(lines[lines.length - 1]).toBe(
      `if-shell -F -t %3 '${AGENT_TAKES_INPUT}' ` +
        '{ paste-buffer -p -d -b tmuxy-review -t %3 ; send-keys -t %3 Enter } ' +
        `{ delete-buffer -b tmuxy-review ; display-message "${REVIEW_REFUSED}" }`,
    );
    // Neither the paste nor the Enter is outside the check.
    expect(lines.filter((line) => /paste-buffer|send-keys/.test(line))).toHaveLength(1);
  });
});
