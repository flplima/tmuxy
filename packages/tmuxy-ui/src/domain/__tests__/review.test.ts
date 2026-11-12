import { describe, it, expect } from 'vitest';
import { namedTarget, reviewPrompt, sendRefusal, commentKey } from '../review';
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
    const agent = modelPane(pid('%3'), wid('@1'));
    expect(sendRefusal(agent)).toBeNull();
    expect(sendRefusal({ ...agent, paneState: 'working' })).toBeNull();
    expect(sendRefusal({ ...agent, paneState: 'needs-input' })).toBe(
      '%3 is waiting for your answer: answer it first, nothing was sent',
    );
    expect(sendRefusal(undefined)).toBe('that pane is gone: nothing was sent');
  });

  it('goes to the pane `--to` named, read from the widget lines', () => {
    expect(namedTarget(['shop', 'to:%12'])).toBe('%12');
    expect(namedTarget(['shop'])).toBeNull();
    expect(namedTarget(['shop', 'to:%12; rm -rf'])).toBeNull();
  });
});
