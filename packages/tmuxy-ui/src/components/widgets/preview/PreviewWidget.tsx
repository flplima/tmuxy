/**
 * The `preview` widget: a local markdown document or page, read again
 * whenever the file changes (`tmuxy open`, packages/tmuxy-cli/bin/tmuxy/tmuxy-widget-preview).
 *
 * The pane's widget lines carry the file's name and a rev that changes with
 * the file; a new rev is what makes the widget read the document again. The
 * document keeps showing while the next one is read, and on a failed read.
 */

import { useEffect, useRef } from 'react';
import { HtmlPreview } from './HtmlPreview';
import { MarkdownPreview } from './MarkdownPreview';
import { usePreviewSource } from './previewSource';
import { usePreviewTheme } from './previewTheme';
import { useKeyedRequest } from './useKeyedRequest';
import type { WidgetProps } from '../registry';
import { parsePreviewLines } from '../../../domain/preview';
import {
  useAppSelector,
  useBindingOwnsKey,
  useIsPaneInActiveWindow,
  usePane,
} from '../../../machines/appHooks';
import { selectReadOnly } from '../../../machines/selectors/ui';

/**
 * A plain key typed at the preview is nobody's: the pane runs no program that
 * reads it, and sent there it would echo onto the screen under the widget
 * marker until the marker scrolled away. So while the preview holds the
 * keyboard, a key with no modifier stops here, and a chord goes on to the app
 * (the prefix, Ctrl+hjkl, and Ctrl+C, which `WidgetPane` turns into the
 * widget's exit) — as does a plain key that is a binding's, the `-` of
 * `prefix -`. The document's capture phase: after every window capture
 * listener, the pager's among them whenever it mounted, and before the
 * keyboard actor's, which listens on the window as the event bubbles back.
 */
function useSwallowedTyping(active: boolean) {
  const activeRef = useRef(active);
  activeRef.current = active;
  const bindingOwnsKey = useBindingOwnsKey();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!activeRef.current || e.ctrlKey || e.altKey || e.metaKey) return;
      if (bindingOwnsKey(e.key)) return;
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [bindingOwnsKey]);
}

export function PreviewWidget({ paneId, lines }: WidgetProps) {
  const { rev, themed } = parsePreviewLines(lines);
  const readOnly = useAppSelector(selectReadOnly);
  const source = usePreviewSource(paneId);
  const theme = usePreviewTheme();
  // Both hooks every render: a `&&` between them would make the second conditional.
  const paneActive = !!usePane(paneId)?.active;
  const inActiveWindow = useIsPaneInActiveWindow(paneId);
  const active = paneActive && inActiveWindow;
  const doc = useKeyedRequest(rev && !readOnly ? rev : null, source.readDocument);
  useSwallowedTyping(active);

  if (readOnly) {
    return (
      <div className="preview-message">
        A preview reads a file on the server&apos;s disk, which read-only viewers are not shown.
      </div>
    );
  }
  if (!doc.value) {
    return <div className="preview-message">{doc.error ?? 'Reading the file…'}</div>;
  }
  return (
    <div className="preview" data-preview-kind={doc.value.kind}>
      {doc.error && <div className="preview-error-banner">{doc.error}</div>}
      {doc.value.kind === 'markdown' ? (
        <MarkdownPreview doc={doc.value} theme={theme} source={source} active={active} />
      ) : (
        <HtmlPreview doc={doc.value} theme={themed ? theme : null} source={source} />
      )}
    </div>
  );
}
