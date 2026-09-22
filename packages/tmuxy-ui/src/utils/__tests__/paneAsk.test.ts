import { describe, expect, it } from 'vitest';
import { answerAskCommand, decodePaneAsk, paneAskFor, type PaneAsk } from '../paneAsk';

/** Encode a payload the way `bin/tmuxy/ask` does. */
function encode(payload: unknown): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  return btoa(String.fromCharCode(...bytes));
}

describe('decodePaneAsk', () => {
  it('reads back what the CLI wrote', () => {
    const ask = decodePaneAsk(
      encode({
        token: '3-4821',
        question: 'Do you want to send keys "npm test Enter"?',
        description: 'Runs the unit suite.',
      }),
    );
    expect(ask).toEqual({
      token: '3-4821',
      question: 'Do you want to send keys "npm test Enter"?',
      description: 'Runs the unit suite.',
    });
  });

  it('survives the characters that would break the list-panes row', () => {
    // A comma shifts every field after it in the comma-separated format, and
    // a quote breaks the JSON. Base64 is what makes both harmless — this is
    // the reason the payload is encoded at all.
    const question = 'Run "build, test, deploy"? It\'s the whole pipeline.';
    expect(decodePaneAsk(encode({ token: 't', question, description: '' }))?.question).toBe(
      question,
    );
  });

  it('decodes a question as UTF-8, not as one byte per character', () => {
    // atob yields bytes; read as Latin-1 an accent comes back as mojibake, and
    // the question the user is asked is not the question that was asked.
    const question = 'Rodar a suíte de testes? 🚀';
    expect(decodePaneAsk(encode({ token: 't', question, description: '' }))?.question).toBe(
      question,
    );
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
    expect(decodePaneAsk(encode({ question: 'no token?' }))).toBeNull();
    expect(decodePaneAsk(encode({ token: '', question: 'blank token' }))).toBeNull();
    expect(decodePaneAsk(encode(['not', 'an', 'object']))).toBeNull();
  });

  it('defaults a missing description to empty', () => {
    expect(decodePaneAsk(encode({ token: 't', question: 'q?' }))?.description).toBe('');
  });
});

describe('paneAskFor', () => {
  it('reads the pane option, and finds nothing on a pane without one', () => {
    expect(paneAskFor({ paneAsk: encode({ token: 't', question: 'q?' }) })?.token).toBe('t');
    expect(paneAskFor({ paneAsk: null })).toBeNull();
    expect(paneAskFor(undefined)).toBeNull();
  });
});

describe('answerAskCommand', () => {
  const ask: PaneAsk = { token: '3-4821', question: 'q?', description: '' };

  it('clears the question before recording the answer', () => {
    // The overlay is what the user is looking at: it comes down as they
    // choose, not once the waiting CLI gets around to sending the keys.
    const command = answerAskCommand('%3', ask, 'yes');
    expect(command.indexOf('-pu -t %3 @tmuxy-ask')).toBeLessThan(
      command.indexOf('@tmuxy-ask-answer'),
    );
  });

  it('pins the answer to the question that was on screen', () => {
    // Without the token, an answer to a question the asker already withdrew
    // would be read as an answer to whatever replaced it.
    expect(answerAskCommand('%3', ask, 'yes')).toContain("@tmuxy-ask-answer '3-4821:yes'");
    expect(answerAskCommand('%3', ask, 'no')).toContain("@tmuxy-ask-answer '3-4821:no'");
  });
});
