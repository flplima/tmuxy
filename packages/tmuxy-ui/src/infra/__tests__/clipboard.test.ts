import { afterEach, describe, it, expect, vi } from 'vitest';
import { pid } from '../../test/wire';
import { clipboardWriteMessage, writeClipboardWhenKnown } from '../clipboard';

/**
 * An OSC 52 write arrives in pane OUTPUT, so `cat` of a crafted file
 * reaches it. The write itself stays allowed — an nvim yank over ssh is why
 * the sequence is honoured — so the signal that it happened is what keeps a
 * clipboard the user did not set from being invisible.
 */
describe('clipboardWriteMessage', () => {
  it('names the pane and the size, so a write the user did not make is visible', () => {
    expect(clipboardWriteMessage('hello world', pid('%3'))).toBe('Copied 11 chars from pane %3');
  });

  it('counts one character in the singular', () => {
    expect(clipboardWriteMessage('x', pid('%0'))).toBe('Copied 1 char from pane %0');
  });

  it('drops the pane clause when there is no pane to name', () => {
    // The paste-buffer mirror carries no pane: tmux does not say which one
    // the yank came from.
    expect(clipboardWriteMessage('abc', null)).toBe('Copied 3 chars');
  });
});

/**
 * WebKit takes a clipboard write only inside the click that asked for it, so
 * text that waits on tmux has to be written as a promise, asked for at once.
 */
describe('writeClipboardWhenKnown', () => {
  /** A clipboard whose `write` records when it was called and what it was handed. */
  function stubClipboard(write: (items: ClipboardItem[]) => Promise<void>) {
    class Item {
      constructor(readonly parts: Record<string, Promise<Blob>>) {}
    }
    vi.stubGlobal('ClipboardItem', Item);
    vi.stubGlobal('navigator', { clipboard: { write, writeText: vi.fn() } });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** jsdom's Blob has no `text()`; its FileReader reads one. */
  const readBlob = (blob: Blob) =>
    new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });

  it('asks for the write before the text is known, and fills it in when it comes', async () => {
    let resolveText = (_: string) => {};
    const text = new Promise<string>((resolve) => (resolveText = resolve));
    const written: Promise<Blob>[] = [];
    const write = vi.fn((items: ClipboardItem[]) => {
      written.push(
        (items[0] as unknown as { parts: Record<string, Promise<Blob>> }).parts['text/plain'],
      );
      return Promise.resolve();
    });
    stubClipboard(write);

    const took = writeClipboardWhenKnown(text, null);
    // Still inside the click: the text has not come, and the write is asked for.
    expect(write).toHaveBeenCalledTimes(1);

    resolveText('### Environment');
    expect(await took).toBe(true);
    expect(await readBlob(await written[0])).toBe('### Environment');
  });

  it('says the write failed when the browser refuses it', async () => {
    stubClipboard(() => Promise.reject(new Error('NotAllowedError')));
    expect(await writeClipboardWhenKnown(Promise.resolve('x'), null)).toBe(false);
  });

  it('writes the text once known where the browser has no ClipboardItem', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('ClipboardItem', undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await writeClipboardWhenKnown(Promise.resolve('later'), null)).toBe(true);
    expect(writeText).toHaveBeenCalledWith('later');
  });
});
