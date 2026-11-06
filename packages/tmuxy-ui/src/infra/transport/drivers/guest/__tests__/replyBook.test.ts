import { describe, expect, it } from 'vitest';
import { ReplyBook } from '../controlMode';

describe('ReplyBook', () => {
  it('resolves each caller with the reply answered under its own id', async () => {
    const book = new ReplyBook();
    const first = book.open();
    const second = book.open();
    expect(first.id).not.toBe(second.id);
    book.resolve(second.id, { output: 'two', error: null });
    book.resolve(first.id, { output: '', error: 'no space for new pane' });
    await expect(first.reply).resolves.toEqual({ output: '', error: 'no space for new pane' });
    await expect(second.reply).resolves.toEqual({ output: 'two', error: null });
  });

  it('settles every caller still waiting when the machine goes away', async () => {
    const book = new ReplyBook();
    const pending = book.open();
    book.failAll('engine reset');
    await expect(pending.reply).resolves.toEqual({ output: '', error: 'engine reset' });
    // A late answer for it changes nothing.
    book.resolve(pending.id, { output: 'late', error: null });
  });
});
