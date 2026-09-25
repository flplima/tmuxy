import { describe, it, expect } from 'vitest';
import { clipboardWriteMessage } from '../clipboard';

/**
 * SEC-01. An OSC 52 write arrives in pane OUTPUT, so `cat` of a crafted file
 * reaches it. The write itself stays allowed — an nvim yank over ssh is why
 * the sequence is honoured — so the signal that it happened is what keeps a
 * clipboard the user did not set from being invisible.
 */
describe('clipboardWriteMessage', () => {
  it('names the pane and the size, so a write the user did not make is visible', () => {
    expect(clipboardWriteMessage('hello world', '%3')).toBe('Copied 11 chars from pane %3');
  });

  it('counts one character in the singular', () => {
    expect(clipboardWriteMessage('x', '%0')).toBe('Copied 1 char from pane %0');
  });

  it('drops the pane clause when there is no pane to name', () => {
    // The paste-buffer mirror carries no pane: tmux does not say which one
    // the yank came from.
    expect(clipboardWriteMessage('abc', '')).toBe('Copied 3 chars');
  });
});
