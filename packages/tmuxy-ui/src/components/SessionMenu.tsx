/**
 * SessionMenu — the session switcher: a dropdown, not a surface.
 *
 * Switching session is a one-line question ("which of these?"), and it used to
 * be answered by a float running a whole widget in a real tmux pane — a window
 * to create, a pane to spawn, a keyboard cursor of its own, and the tab behind
 * it dimmed while you read four names. A dropdown anchored to the thing you
 * clicked says the same thing without taking the screen.
 *
 * What it lists is the sessions on the socket this client is attached to
 * (`serversActor` polls them), which is the set `switch-client` can reach —
 * instant, and as available to a viewer as to a writer, since it changes only
 * this client.
 *
 * Servers are a second section, and only when there is more than one to
 * choose: attaching to another socket is not a `switch-client` but a
 * retarget of the backend's monitor (`connect_server`), which is a Tauri
 * command — a web client is served by a server pinned to one socket at
 * launch, so its list holds nothing to offer. Adding a server is a FORM, and
 * a form needs somewhere to type, so that one item opens a pane.
 *
 * Its body is a filter box over a scrolling list (SessionPicker), so it is
 * drawn in-app on every platform: a native popup has nowhere to type.
 *
 * The other session verbs (new, rename, detach, kill) live in the app menu,
 * where the rest of the session's commands are.
 */

import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppSelector } from '../machines/appHooks';
import { selectAnimationsAllowed } from '../machines/selectors/ui';
import {
  SURFACE_EXIT_MS,
  surfacePortalTarget,
  useFloatingSurface,
} from './floating/useFloatingSurface';
import { useMenuDispatch } from './menus/SpecMenu';
import { SessionPicker, type SwitcherItem } from './SessionPicker';

/** The open state handed to `useFloatingSurface`: one value, so its key never changes. */
const OPEN = { open: true } as const;

interface SessionMenuProps {
  /**
   * The control the dropdown hangs from. An element rather than a point,
   * because the surface measures both to keep the dropdown on screen — and
   * which SIDE it opens on follows from that: the status line's switcher is a
   * 27px strip on the last row of the window, so its dropdown is placed above
   * rather than off the bottom of the screen (`positionSurface`).
   */
  // `useRef<T>(null)` yields `RefObject<T | null>`; the dropdown reads
  // `.current` only once it is open, by which point React has attached it.
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

export function SessionMenu({ anchorRef, onClose }: SessionMenuProps) {
  const sessionName = useAppSelector((ctx) => ctx.sessionName);
  const currentServerId = useAppSelector((ctx) => ctx.currentServerId);
  const animations = useAppSelector(selectAnimationsAllowed);
  const dispatch = useMenuDispatch();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const { ref, shown, reposition } = useFloatingSurface<typeof OPEN>({
    id: 'session-menu',
    content: OPEN,
    anchor: { kind: 'element', element: anchorRef.current },
    placement: { align: 'start' },
    exitMs: SURFACE_EXIT_MS,
    animated: animations,
    onDismiss: () => closeRef.current(),
  });

  /**
   * Placed again whenever its box changes — the poll filling the list after it
   * opened — but never smaller than it has been. Opening upward, the dropdown
   * is placed by its height, so a list that shrank as you typed would pull the
   * box you are typing in down under the cursor on every key.
   */
  useEffect(() => {
    const surface = ref.current;
    if (!shown || !surface || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      surface.style.minWidth = `${surface.offsetWidth}px`;
      surface.style.minHeight = `${surface.offsetHeight}px`;
      reposition();
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, [shown, ref, reposition]);

  // A press anywhere else puts it away — except on the control that opened
  // it, whose own click is the toggle (otherwise the press that closes it is
  // also the click that reopens it).
  useEffect(() => {
    if (!shown) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || ref.current?.contains(target) || anchorRef.current?.contains(target)) return;
      closeRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [shown, ref, anchorRef]);

  const choose = useCallback(
    ({ action }: SwitcherItem) => {
      // Picking the session or server already attached changes nothing.
      const same =
        action.kind === 'event' &&
        ((action.event.type === 'SWITCH_SESSION' && action.event.sessionName === sessionName) ||
          (action.event.type === 'CONNECT_SERVER' && action.event.serverId === currentServerId));
      if (!same) dispatch(action);
      closeRef.current();
    },
    [dispatch, sessionName, currentServerId],
  );

  if (!shown) return null;

  return createPortal(
    <div
      ref={ref}
      className="floating-surface session-switcher"
      role="dialog"
      aria-label="Switch session"
      data-testid="session-switcher"
    >
      <SessionPicker onChoose={choose} onEscape={() => closeRef.current()} />
    </div>,
    surfacePortalTarget(),
  );
}
