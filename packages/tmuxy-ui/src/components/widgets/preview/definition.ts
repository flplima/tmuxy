import type { WidgetDefinition } from '../registry';
import { event } from '../../menus/specs/actions';
import { PreviewWidget } from './PreviewWidget';
import { parsePreviewLines } from '../../../domain/preview';

/**  nf-fa-file_text_o — a document. */
const DOCUMENT_ICON = '';

export const previewWidget: WidgetDefinition = {
  component: PreviewWidget,
  icon: DOCUMENT_ICON,
  selectTitle: (_context, _paneId, lines) => parsePreviewLines(lines).file || undefined,
  selectMenuItems: (_context, paneId) => [
    {
      kind: 'item',
      id: 'widget:preview-close',
      label: 'Close Preview',
      keyHint: 'ctrl+c',
      data: { 'widget-action': 'preview-close' },
      action: event({ type: 'SEND_KEYS', paneId, keys: 'C-c' }),
    },
  ],
};
