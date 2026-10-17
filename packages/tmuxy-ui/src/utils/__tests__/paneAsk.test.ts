import { describe, expect, it } from 'vitest';
import { decodePaneAsk, paneAskFor, sentText, sentTextIsLong } from '../paneAsk';

/** Encode a payload the way `bin/tmuxy/send` does. */
function encode(payload: unknown): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  return btoa(String.fromCharCode(...bytes));
}

describe('decodePaneAsk', () => {
  it('reads back what the CLI wrote', () => {
    const ask = decodePaneAsk(
      encode({ token: '3-4821', caller: 'claude', keys: ['npm test', 'Enter'] }),
    );
    expect(ask).toEqual({ token: '3-4821', caller: 'claude', keys: ['npm test', 'Enter'] });
  });

  it('survives the characters that would break the list-panes row', () => {
    // A comma shifts every field after it in the comma-separated format, and
    // a quote breaks the JSON. Base64 is what makes both harmless — this is
    // the reason the payload is encoded at all.
    const keys = ['echo "build, test, deploy" it\'s all', 'Enter'];
    expect(decodePaneAsk(encode({ token: 't', caller: 'claude', keys }))?.keys).toEqual(keys);
  });

  it('decodes the keys as UTF-8, not as one byte per character', () => {
    // atob yields bytes; read as Latin-1 an accent comes back as mojibake, and
    // what the user is asked to allow is not what would be sent.
    const keys = ['echo suíte 🚀'];
    expect(decodePaneAsk(encode({ token: 't', caller: 'claude', keys }))?.keys).toEqual(keys);
  });

  it('treats an unset option as no question', () => {
    expect(decodePaneAsk(undefined)).toBeNull();
    expect(decodePaneAsk(null)).toBeNull();
    expect(decodePaneAsk('')).toBeNull();
  });

  it('refuses a payload it cannot read rather than blurring the pane', () => {
    // A half-written option caught mid-round-trip must not leave a pane behind
    // an overlay with nothing in it and no way to dismiss it.
    expect(decodePaneAsk('not base64 at all!')).toBeNull();
    expect(decodePaneAsk(btoa('{"token":'))).toBeNull();
    expect(decodePaneAsk(encode({ token: 't' }))).toBeNull();
    expect(decodePaneAsk(encode({ keys: ['ls'] }))).toBeNull();
    expect(decodePaneAsk(encode({ token: '', keys: ['ls'] }))).toBeNull();
    expect(decodePaneAsk(encode({ token: 't', keys: [] }))).toBeNull();
    expect(decodePaneAsk(encode({ token: 't', keys: ['ls', 3] }))).toBeNull();
    expect(decodePaneAsk(encode(['not', 'an', 'object']))).toBeNull();
  });

  it('names an unknown caller rather than leaving a blank in the question', () => {
    expect(decodePaneAsk(encode({ token: 't', keys: ['ls'] }))?.caller).toBe('a script');
  });
});

describe('paneAskFor', () => {
  it('reads the pane option, and finds nothing on a pane without one', () => {
    expect(paneAskFor({ paneAsk: encode({ token: 't', keys: ['ls'] }) })?.token).toBe('t');
    expect(paneAskFor({ paneAsk: null })).toBeNull();
    expect(paneAskFor(undefined)).toBeNull();
  });
});

describe('sentText', () => {
  it('joins the arguments with nothing between them, as send-keys types them', () => {
    expect(sentText(['npm', 'test'])).toBe('npmtest');
    expect(sentText(['npm test'])).toBe('npm test');
  });

  it('drops the Enter that runs the last line, and keeps the others as line breaks', () => {
    expect(sentText(['npm test', 'Enter'])).toBe('npm test');
    expect(sentText(['cd web', 'Enter', 'make', 'C-m'])).toBe('cd web\nmake');
  });

  it('shows any other key name as a key, and Space as a space', () => {
    expect(sentText(['C-c', 'ls', 'Space', '-la', 'Escape'])).toBe('‹C-c›ls -la‹Escape›');
  });
});

describe('sentTextIsLong', () => {
  it('keeps a short one-liner inline and gives the rest a block', () => {
    expect(sentTextIsLong('npm test')).toBe(false);
    expect(sentTextIsLong('cd web\nmake')).toBe(true);
    expect(sentTextIsLong('x'.repeat(49))).toBe(true);
  });
});
