/**
 * Debug > Copy Trace…: the last actions of the trace, redacted for sharing,
 * shown in full before anything is copied. Session names, paths, error text,
 * command arguments and marker labels are already placeholders
 * (`trace::share` in tmuxy-core); what the preview shows is exactly what
 * the Copy button puts on the clipboard. Nothing is sent anywhere.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Effect } from 'effect';
import { writeClipboard } from '../../infra/clipboard';
import { TmuxTransport } from '../../infra/transport/TmuxTransport';
import { useAppRuntime } from '../../machines/appHooks';
import { Modal } from '../Modal';
import type { ClipboardReport } from './copyAppState';

/** How many of the latest actions the preview takes. */
const LAST_ACTIONS = 20;

type Slice = { text: string; lines: number } | { error: string } | null;

export function CopyTraceDialog({
  onClose,
  report,
}: {
  onClose: () => void;
  report: ClipboardReport;
}) {
  const runtime = useAppRuntime();
  const [slice, setSlice] = useState<Slice>(null);
  useEffect(() => {
    let current = true;
    const ask = Effect.gen(function* () {
      const transport = yield* TmuxTransport;
      return yield* transport.call('get_trace_share', { last: LAST_ACTIONS });
    });
    void runtime
      .runPromise(ask)
      .then(
        (share): Slice => share,
        (e: unknown): Slice => ({ error: e instanceof Error ? e.message : String(e) }),
      )
      .then((answer) => {
        if (current) setSlice(answer);
      });
    return () => {
      current = false;
    };
  }, [runtime]);

  const text = slice && 'text' in slice ? slice.text : '';
  const copy = () => {
    void writeClipboard(text, null).then((ok) =>
      ok
        ? report.onCopied('Copied the redacted trace: check it before you share it')
        : report.onFailed('Clipboard write failed'),
    );
    onClose();
  };

  return createPortal(
    <Modal open title="Copy Trace" width={640} onClose={onClose}>
      <p className="app-menu-dialog-text">
        The last {LAST_ACTIONS} actions, redacted: session names, paths, error text and command
        arguments are replaced by placeholders. This is exactly what will be copied.
      </p>
      {slice === null && <p className="app-menu-dialog-text">Reading the trace…</p>}
      {slice && 'error' in slice && <p className="app-menu-dialog-text">{slice.error}</p>}
      {slice && 'text' in slice && (
        <pre className="trace-share-preview" data-testid="trace-share-preview">
          {slice.text || '(no actions traced yet)'}
        </pre>
      )}
      <div className="app-menu-dialog-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" disabled={!text} onClick={copy}>
          Copy {slice && 'lines' in slice ? `${slice.lines} lines` : ''}
        </button>
      </div>
    </Modal>,
    document.body,
  );
}
