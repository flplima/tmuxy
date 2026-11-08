/**
 * Dictation for the phone's mic key (components/phone/KeyRow.tsx): the browser's
 * own speech recognition (the Web Speech API) listens until the speaker
 * pauses, and what it heard goes to the pane as typed text.
 *
 * Chrome and Safari carry it, prefixed as `webkitSpeechRecognition`, and only
 * on a secure page; the recogniser itself may run on the browser maker's
 * servers. Firefox has none, and the key says so when tapped.
 */

/** The slice of a `SpeechRecognition` this file uses. */
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Whether this browser can take dictation at all. */
export function dictationSupported(): boolean {
  return recognitionConstructor() !== null;
}

export interface DictationHandlers {
  /** Words heard and settled: type them into the pane. */
  onText: (text: string) => void;
  /** Listening started or stopped. */
  onListening: (listening: boolean) => void;
  /** Why it could not listen, in words for a notice. */
  onError: (message: string) => void;
}

/** What a recogniser's error code means for the person who tapped the key. */
export function dictationErrorMessage(code: string): string | null {
  switch (code) {
    // Nothing said before it gave up, or the tap that stopped it: no notice.
    case 'no-speech':
    case 'aborted':
      return null;
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Dictation needs the microphone: allow it for this site';
    case 'audio-capture':
      return 'No microphone was found';
    case 'network':
      return 'Dictation needs the network, and could not reach it';
    default:
      return `Dictation stopped (${code})`;
  }
}

/** The settled words in a result event, joined. */
export function finalTranscript(event: RecognitionResultEvent): string {
  let text = '';
  for (let i = event.resultIndex; i < event.results.length; i++) {
    const result = event.results[i];
    if (result.isFinal) text += result[0].transcript;
  }
  return text.trim();
}

/**
 * A dictation session: `toggle()` starts listening, or stops it early (what
 * was heard so far still arrives). One utterance per start: the recogniser
 * ends by itself when the speaker pauses.
 */
export function createDictation(handlers: DictationHandlers) {
  let current: Recognition | null = null;

  const start = () => {
    const Ctor = recognitionConstructor();
    if (!Ctor) {
      handlers.onError('This browser has no dictation');
      return;
    }
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (event) => {
      const text = finalTranscript(event);
      if (text) handlers.onText(text);
    };
    rec.onerror = (event) => {
      const message = dictationErrorMessage(event.error);
      if (message) handlers.onError(message);
    };
    rec.onend = () => {
      if (current === rec) current = null;
      handlers.onListening(false);
    };
    current = rec;
    try {
      rec.start();
      handlers.onListening(true);
    } catch (e: unknown) {
      current = null;
      handlers.onError(`Dictation could not start: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return {
    toggle() {
      if (current) current.stop();
      else start();
    },
    /** Stop listening, and drop whatever is still to come. */
    dispose() {
      const rec = current;
      current = null;
      if (rec) {
        rec.onresult = null;
        rec.onend = null;
        rec.stop();
      }
    },
  };
}
