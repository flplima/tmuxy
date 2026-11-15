/**
 * The `preview` widget: a local markdown document or page (`tmuxy open`,
 * `tmuxy-widget-preview`), read again whenever the rev in the pane's widget lines
 * changes. The document keeps showing while the next one is read, and on a
 * failed read.
 */

import { useCallback } from 'react';
import { HtmlPreview } from './HtmlPreview';
import { MarkdownPreview } from './MarkdownPreview';
import { usePreviewSource } from './previewSource';
import { usePreviewTheme } from './previewTheme';
import { useKeyedRequest } from './useKeyedRequest';
import { useSwallowedTyping } from '../useSwallowedTyping';
import type { WidgetProps } from '../registry';
import { parsePreviewLines } from '../../../domain/preview';
import { TmuxOp } from '../../../domain/commands';
import './preview.css';
import { useAppSelector, useAppSend } from '../../../machines/appHooks';
import { selectPaneHoldsKeyboard } from '../../../machines/selectors/keyboard';

export function PreviewWidget({ paneId, lines }: WidgetProps) {
  const { rev, themed } = parsePreviewLines(lines);

  const send = useAppSend();
  const source = usePreviewSource(paneId);
  const theme = usePreviewTheme();
  const active = useAppSelector((ctx) => selectPaneHoldsKeyboard(ctx, paneId));
  const doc = useKeyedRequest(rev || null, source.readDocument);
  useSwallowedTyping(active);
  const onInput = useCallback(
    (json: string) => {
      send({ type: 'DISPATCH_OP', op: TmuxOp.SendText({ target: paneId, text: `${json}\n` }) });
    },
    [send, paneId],
  );

  if (!doc.value) {
    return <div className="preview-message">{doc.error ?? 'Reading the file…'}</div>;
  }
  return (
    <div className="preview" data-preview-kind={doc.value.kind}>
      {doc.error && <div className="preview-error-banner">{doc.error}</div>}
      {doc.value.kind === 'markdown' ? (
        <MarkdownPreview
          doc={doc.value}
          theme={theme}
          source={source}
          active={active}
          onInput={onInput}
        />
      ) : (
        <HtmlPreview doc={doc.value} theme={themed ? theme : null} source={source} />
      )}
    </div>
  );
}
