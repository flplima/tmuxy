/**
 * A program in a pane sets the clipboard (OSC 52). The status line says what
 * the browser did with it, not what was asked of it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { pid } from '../../../test/wire';
import { startApp } from '../../../test/app';

function clipboardThat(writeText: (text: string) => Promise<void>) {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
}

async function statusAfterPaneCopies(text: string) {
  const actor = startApp();
  actor.send({ type: 'TMUX_CLIPBOARD', paneId: pid('%6'), text });
  await vi.waitFor(() => expect(actor.getSnapshot().context.statusMessage).not.toBeNull());
  return actor.getSnapshot().context.statusMessage?.text;
}

describe('a pane writes the clipboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('says it copied when the browser took the write', async () => {
    const written: string[] = [];
    clipboardThat(async (text) => void written.push(text));
    expect(await statusAfterPaneCopies('late-osc52')).toBe('Copied 10 chars from pane %6');
    expect(written).toEqual(['late-osc52']);
  });

  it('says it could not, and why, when the browser refused for want of a key or a click', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Firefox: "Clipboard write was blocked due to lack of user activation."
    clipboardThat(() => Promise.reject(new DOMException('blocked', 'NotAllowedError')));
    expect(await statusAfterPaneCopies('late-osc52')).toBe(
      'Pane %6 could not copy 10 chars: the browser wants a key or a click first',
    );
  });

  it('says the page has no clipboard when it is served without https off localhost', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    expect(await statusAfterPaneCopies('x')).toBe(
      'Pane %6 could not copy 1 char: no clipboard without https or localhost',
    );
  });
});
