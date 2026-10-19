import { useRef, useState } from 'react';

export interface KeyedAnswer<T> {
  value: T | null;
  error: string | null;
}

/**
 * The latest answer to `request`, asked again whenever `key` changes.
 *
 * Asked during render, not in an effect (packages/tmuxy-ui/README.md): a render
 * with a new key starts the request, and an answer whose key is no longer the
 * current one is dropped — which also covers an answer arriving after unmount.
 * The previous value is kept while the next is on its way, so a document being
 * read again never blanks the pane; a failure keeps it too, beside the error.
 */
export function useKeyedRequest<T>(key: string | null, request: () => Promise<T>): KeyedAnswer<T> {
  const [answer, setAnswer] = useState<KeyedAnswer<T>>({ value: null, error: null });
  const keyRef = useRef<string | null>(null);
  if (key !== null && key !== keyRef.current) {
    keyRef.current = key;
    request().then(
      (value) => {
        if (keyRef.current === key) setAnswer({ value, error: null });
      },
      (e: unknown) => {
        if (keyRef.current !== key) return;
        const error = e instanceof Error ? e.message : String(e);
        setAnswer((previous) => ({ value: previous.value, error }));
      },
    );
  }
  return answer;
}
