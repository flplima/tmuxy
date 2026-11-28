/**
 * The widget a pane is showing, derived once for every surface that asks: the
 * pane body (tiled or float), its header tab and icon, the tree row and the
 * pane menu.
 *
 * Latched across content that is not captured yet (`notCapturedYet`): a
 * pane's rows briefly go while a capture refresh is in flight (a resize, a
 * window move, the `swap-pane` of a group switch), and classifying that gap
 * as "terminal" would switch the rendered component type — React unmounts the
 * widget and mounts a terminal, then the other way round when the content
 * returns, a full-pane blink twice over. The latch holds only while the tag
 * is unchanged, so an untagged pane never inherits a widget from an earlier
 * pane that had its id.
 *
 * Latched too while the pane is collapsed (`isCollapsedPane`, a stacked
 * window's other rows): one row cannot hold the marker and the lines below
 * it, so tmux pushes them into the history and the screen holds only the
 * cursor's empty row. Read as "terminal", the collapsed preview's tree row
 * and header fell back to `bash`, and the widget unmounted, so expanding the
 * pane mounted it afresh and read its document again.
 */

import { notCapturedYet } from '../../domain/deltaProtocol';
import { isCollapsedPane } from '../../domain/paneGeometry';
import { findPaneWidget, type PaneWidget } from '../../domain/paneWidget';
import type { TmuxPane } from '../../domain/client';
import type { PaneId } from '../../domain/ids';

interface Latch {
  content: TmuxPane['content'];
  authorized: string | null;
  widget: PaneWidget | null;
}

const latches = new Map<PaneId, Latch>();

export function selectPaneWidget(
  pane: Pick<TmuxPane, 'tmuxId' | 'content' | 'paneWidget' | 'height'> | null | undefined,
): PaneWidget | null {
  if (!pane) return null;
  const last = latches.get(pane.tmuxId);
  const authorized = pane.paneWidget ?? null;
  const sameTag = last !== undefined && last.authorized === authorized;
  const held = notCapturedYet(pane.content) || isCollapsedPane(pane);
  if (sameTag && (held || last.content === pane.content)) return last.widget;
  const widget = held ? null : findPaneWidget(pane.content, authorized);
  latches.set(pane.tmuxId, { content: pane.content, authorized, widget });
  return widget;
}
