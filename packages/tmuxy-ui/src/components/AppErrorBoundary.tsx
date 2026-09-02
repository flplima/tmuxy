/**
 * AppErrorBoundary — the last thing between a render-time exception and a
 * blank page.
 *
 * A state update the client cannot digest used to propagate out of the render
 * tree and unmount the whole app, leaving a dark, empty document with the
 * only clue in the console. This boundary keeps the document readable: it
 * names the error and offers a reload, which re-syncs from a fresh snapshot.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('tmuxy UI crashed while rendering:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error fatal" data-testid="ui-crash-display" role="alert">
        <h2>The tmuxy UI hit an error</h2>
        <p className="status-message">{this.state.error.message}</p>
        <p className="status-hint">
          Your tmux session is untouched. Reload to reconnect and pick up a fresh snapshot.
        </p>
        <button type="button" className="ui-crash-reload" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
