/** The browser widget's page-size menu: one radio per viewport the live page can take. */

import { LIVE_VIEWPORTS, verbLine } from '../../components/widgets/browser/live';
import type { PaneId } from '../ids';
import { event, type MenuSpec } from './spec';

export function browserSizeMenuSpec(paneId: PaneId, viewport: string): MenuSpec {
  return [
    {
      kind: 'radio-group',
      id: 'browser-viewport',
      value: viewport,
      options: LIVE_VIEWPORTS.map((option) => ({
        value: option.value,
        label: option.label,
        action: event({
          type: 'WRITE_TO_PANE',
          paneId,
          data: verbLine(`viewport ${option.value}`),
        }),
      })),
    },
  ];
}
