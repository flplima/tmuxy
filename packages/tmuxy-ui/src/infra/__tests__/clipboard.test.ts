import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { pid } from '../../test/wire';
import {
  clipboardBlockedMessage,
  clipboardWriteMessage,
  copyForProgram,
  writeClipboardWhenKnown,
} from '../clipboard';

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

/**
 * Firefox and Safari refuse a clipboard write that no recent key or click
 * came before. A program asking for one on its own (`sleep 10; printf OSC 52`)
 * is turned down, so the text waits for the next gesture.
 */
describe('copyForProgram', () => {
  let fresh = false;
  const taken: string[] = [];
  const said: string[] = [];
  const say = (message: string) => said.push(message);

  /** A browser event, during which the "gesture" is fresh. */
  const gesture = async (event: Event) => {
    fresh = true;
    window.dispatchEvent(event);
    fresh = false;
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  beforeEach(() => {
    fresh = false;
    taken.length = 0;
    said.length = 0;
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: (text: string) =>
          fresh
            ? (taken.push(text), Promise.resolve())
            : Promise.reject(new DOMException('needs a gesture', 'NotAllowedError')),
      },
    });
  });

  afterEach(async () => {
    // Settle whatever a test left waiting, so it cannot reach the next one.
    await copyForProgram('', null, () => {});
    vi.unstubAllGlobals();
  });

  it('says what it will do when the browser refuses, and writes on the next key', async () => {
    expect(await copyForProgram('hi', pid('%1'), say)).toBe(false);
    expect(said).toEqual(['Pane %1 could not copy 2 chars: press a key or click to copy']);
    expect(taken).toEqual([]);

    await gesture(new KeyboardEvent('keydown', { key: 'a' }));
    expect(taken).toEqual(['hi']);
    expect(said[said.length - 1]).toBe('Copied 2 chars from pane %1');
  });

  it('writes on the next click too', async () => {
    await copyForProgram('hi', null, say);
    await gesture(new MouseEvent('mousedown'));
    expect(taken).toEqual(['hi']);
  });

  it('waits for a lifted finger, not a landing one, which a phone does not count', async () => {
    await copyForProgram('hi', null, say);
    await gesture(new Event('pointerdown'));
    expect(taken).toEqual([]);
    await gesture(new Event('pointerup'));
    expect(taken).toEqual(['hi']);
  });

  it('keeps the text when the browser refuses the retry too, for the gesture after', async () => {
    await copyForProgram('hi', null, say);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(taken).toEqual([]);
    await gesture(new KeyboardEvent('keydown', { key: 'b' }));
    expect(taken).toEqual(['hi']);
  });

  it('writes once: the text is forgotten after the gesture', async () => {
    await copyForProgram('hi', null, say);
    await gesture(new KeyboardEvent('keydown', { key: 'a' }));
    await gesture(new KeyboardEvent('keydown', { key: 'b' }));
    expect(taken).toEqual(['hi']);
  });

  it('keeps only the newest request', async () => {
    await copyForProgram('old', null, say);
    await copyForProgram('new', null, say);
    await gesture(new KeyboardEvent('keydown', { key: 'a' }));
    expect(taken).toEqual(['new']);
  });

  it('forgets a request a later write that took has replaced', async () => {
    await copyForProgram('old', null, say);
    fresh = true;
    expect(await copyForProgram('new', null, say)).toBe(true);
    fresh = false;
    await gesture(new KeyboardEvent('keydown', { key: 'a' }));
    expect(taken).toEqual(['new']);
  });

  it('does not promise a retry where there is no clipboard at all', async () => {
    vi.stubGlobal('navigator', {});
    expect(await copyForProgram('hi', null, say)).toBe(false);
    expect(said).toEqual(['Could not copy 2 chars: no clipboard without https or localhost']);
    expect(clipboardBlockedMessage('hi', null, true)).toContain('no clipboard');
  });
});
