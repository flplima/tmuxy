/**
 * The preview widget, loaded when a pane first shows one: it brings the
 * markdown renderer and the diagram engine with it, which the terminal view
 * never needs, so the page's first paint does not wait for them.
 */

import { lazy, Suspense } from 'react';
import type { WidgetProps } from '../registry';

const PreviewWidget = lazy(() =>
  import('./PreviewWidget').then((module) => ({ default: module.PreviewWidget })),
);

export function PreviewWidgetLoader(props: WidgetProps) {
  return (
    <Suspense fallback={<div className="widget-loading" data-widget-loading="" />}>
      <PreviewWidget {...props} />
    </Suspense>
  );
}
