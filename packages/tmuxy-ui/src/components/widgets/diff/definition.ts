import type { WidgetDefinition } from '../registry';
import { event } from '../../menus/specs/actions';
import { TmuxOp } from '../../../domain/commands';
import { DiffWidget } from './DiffWidget';

/**  nf-oct-diff — a diff. */
const DIFF_ICON = '';

export const diffWidget: WidgetDefinition = {
  component: DiffWidget,
  icon: DIFF_ICON,
  // The first line under the marker is the checkout's folder name.
  selectTitle: (_context, _paneId, lines) => (lines[0] ? `diff: ${lines[0]}` : undefined),
  selectMenuItems: (_context, paneId) => [
    {
      kind: 'item',
      id: 'widget:diff-close',
      label: 'Close Diff',
      keyHint: 'ctrl+c',
      data: { 'widget-action': 'diff-close' },
      action: event({ type: 'DISPATCH_OP', op: TmuxOp.SendKeys({ target: paneId, keys: 'C-c' }) }),
    },
  ],
};
