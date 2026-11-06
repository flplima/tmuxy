/**
 * The `preview` widget: a local markdown document or page (`tmuxy open`,
 * `tmuxy-widget-preview`), read again whenever the rev in the pane's widget lines
 * changes. The document keeps showing while the next one is read, and on a
 * failed read.
 */

import { useEffect, useRef } from 'react';
import { HtmlPreview } from './HtmlPreview';
import { MarkdownPreview } from './MarkdownPreview';
import { usePreviewSource } from './previewSource';
import { usePreviewTheme } from './previewTheme';
import { useKeyedRequest } from './useKeyedRequest';
import type { WidgetProps } from '../registry';
import { parsePreviewLines } from '../../../domain/preview';
import './preview.css';
import { useBindingOwnsKey, useIsPaneInActiveWindow, usePane } from '../../../machines/appHooks';

/**
 * A plain key typed at the preview is nobody's: the pane runs no program that
 * reads it, and sent there it would echo under the widget marker. So a key with
 * no modifier stops here, unless a binding owns it (the `-` of `prefix -`); a
 * chord goes on to the app (the prefix, Ctrl+hjkl, and Ctrl+C, which
 * `WidgetPane` turns into the widget's exit). The document's capture phase runs
 * after every window capture listener (the pager's among them) and before the
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

  const source = usePreviewSource(paneId);
  const theme = usePreviewTheme();
  // Both hooks every render: a `&&` between them would make the second conditional.
  const paneActive = !!usePane(paneId)?.active;
  const inActiveWindow = useIsPaneInActiveWindow(paneId);
  const active = paneActive && inActiveWindow;
  const doc = useKeyedRequest(rev || null, source.readDocument);
  useSwallowedTyping(active);

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
