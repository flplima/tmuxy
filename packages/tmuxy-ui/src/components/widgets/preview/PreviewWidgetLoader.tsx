/**
 * The preview widget, loaded when a pane first shows one: it brings the
 * markdown renderer and the diagram engine with it, which the terminal view
 * never needs, so the page's first paint does not wait for them.
 */

import { Component, lazy, Suspense, type ReactNode } from 'react';
import type { WidgetProps } from '../registry';

const PreviewWidget = lazy(() =>
  import('./PreviewWidget').then((module) => ({ default: module.PreviewWidget })),
);

/**
 * The widget's code could not be loaded: most often a page left open across
 * a server update, which no longer has the file the page was built to ask
 * for. Only this pane says so; the terminal and every other pane go on.
 */
class WidgetLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="widget-load-failed" role="alert" data-widget-load-failed="">
        <p>This preview could not be loaded: tmuxy was probably updated since this page opened.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload to show it
        </button>
      </div>
    );
  }
}

export function PreviewWidgetLoader(props: WidgetProps) {
  return (
    <WidgetLoadBoundary>
      <Suspense fallback={<div className="widget-loading" data-widget-loading="" />}>
        <PreviewWidget {...props} />
      </Suspense>
    </WidgetLoadBoundary>
  );
}
