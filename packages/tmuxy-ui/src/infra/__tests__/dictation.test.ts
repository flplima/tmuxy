import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDictation,
  dictationErrorMessage,
  dictationSupported,
  finalTranscript,
} from '../dictation';

/** A recogniser the test drives: it records what was asked of it. */
class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = '';
  continuous = true;
  interimResults = true;
  maxAlternatives = 0;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;
  stopped = 0;
  constructor() {
    FakeRecognition.last = this;
  }
  start() {
    this.started++;
  }
  stop() {
    this.stopped++;
  }
  hear(...results: Array<[string, boolean]>) {
    this.onresult?.({
      resultIndex: 0,
      results: results.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })),
    });
  }
}

const handlers = () => ({ onText: vi.fn(), onListening: vi.fn(), onError: vi.fn() });

afterEach(() => {
  vi.unstubAllGlobals();
  FakeRecognition.last = null;
});

describe('dictation', () => {
  it('listens for one utterance and types only the settled words', () => {
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    expect(dictationSupported()).toBe(true);
    const h = handlers();
    const d = createDictation(h);

    d.toggle();
    const rec = FakeRecognition.last!;
    expect(rec.started).toBe(1);
    expect(rec.continuous).toBe(false);
    expect(rec.interimResults).toBe(false);
    expect(h.onListening).toHaveBeenLastCalledWith(true);

    rec.hear([' git status ', true], ['and', false]);
    expect(h.onText).toHaveBeenCalledWith('git status');
    rec.onend?.();
    expect(h.onListening).toHaveBeenLastCalledWith(false);

    // The next tap starts a new one rather than stopping the last.
    d.toggle();
    expect(FakeRecognition.last).not.toBe(rec);
  });

  it('a tap while listening stops it, and the words heard so far still arrive', () => {
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    const h = handlers();
    const d = createDictation(h);
    d.toggle();
    const rec = FakeRecognition.last!;
    d.toggle();
    expect(rec.stopped).toBe(1);
    rec.hear(['ls', true]);
    expect(h.onText).toHaveBeenCalledWith('ls');
  });

  it('says why when there is no recogniser or no microphone, and stays quiet on silence', () => {
    const h = handlers();
    expect(dictationSupported()).toBe(false);
    createDictation(h).toggle();
    expect(h.onError).toHaveBeenCalledWith('This browser has no dictation');

    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    const h2 = handlers();
    createDictation(h2).toggle();
    FakeRecognition.last!.onerror?.({ error: 'no-speech' });
    expect(h2.onError).not.toHaveBeenCalled();
    FakeRecognition.last!.onerror?.({ error: 'not-allowed' });
    expect(h2.onError).toHaveBeenCalledWith(dictationErrorMessage('not-allowed'));
  });

  it('dispose drops what is still to come', () => {
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    const h = handlers();
    const d = createDictation(h);
    d.toggle();
    const rec = FakeRecognition.last!;
    d.dispose();
    expect(rec.stopped).toBe(1);
    rec.hear(['late', true]);
    expect(h.onText).not.toHaveBeenCalled();
  });

  it('joins the settled results from the event index on', () => {
    expect(
      finalTranscript({
        resultIndex: 1,
        results: [
          { isFinal: true, 0: { transcript: 'old ' } },
          { isFinal: true, 0: { transcript: 'new ' } },
          { isFinal: true, 0: { transcript: 'words' } },
        ],
      }),
    ).toBe('new words');
  });
});
