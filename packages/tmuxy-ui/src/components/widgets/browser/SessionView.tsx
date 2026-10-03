/**
 * The live page of a SERVER-SIDE browser session, in the pane.
 *
 * The other three source kinds are fetched by the viewer's own browser. This
 * one is not: the page was fetched by a headless engine on the machine the
 * server runs on, and what arrives here is a picture of it. That is what lets
 * the pane show a site which refuses to be framed, and what lets the page
 * outlive the tab — see `packages/tmuxy-server/src/browser/`.
 *
 * ## It is one `<img>`
 *
 * The frames arrive as `multipart/x-mixed-replace`, which a browser decodes in
 * an `<img>` natively. So there is no per-frame JavaScript here at all: one
 * `src`, and the browser paints each part as it lands. The alternative — frames
 * over SSE as base64 into a canvas — would put a megabyte a second through the
 * channel that carries keystroke echo, pay 33% for base64, and hand the work to
 * the main thread.
 *
 * A consequence worth knowing when reading this file: there is no "frame"
 * state, no decode callback and no animation loop, because the element is doing
 * all of it.
 *
 * ## Zoom is applied once, on the server
 *
 * The frame carries no transform. Zoom changes the VIEWPORT the engine lays the
 * page out at — a 2x pane asks for half the width and the picture is shown at
 * full size — which is what a real browser's page zoom does, and the reason
 * text re-wraps instead of being cropped. Scaling the image here as well would
 * apply zoom twice.
 *
 * ## Input goes the long way round on purpose
 *
 * Pointer events are handled here, because they are this element's own. KEYS
 * are not: they are routed by the widget's `onKeyDown` in `definition.ts`,
 * which declines everything `tmuxyOwnsKey` claims before forwarding the rest.
 * That handler runs capture-phase, ahead of the keyboard actor, so a widget
 * which forwarded every key would swallow the tmux prefix and make its own
 * pane impossible to leave. Declining is what keeps the precedence right.
 */

import { memo, useCallback, useEffect, useRef } from 'react';
import { useAppSend, useReadOnly } from '../../../machines/AppContext';
import { sessionStreamUrl } from './source';

/**
 * How long to wait after a resize before telling the engine.
 *
 * A drag of a pane border produces a resize per frame, and each one is a
 * viewport change that makes Chromium re-layout the whole page. Coalescing them
 * means the page re-lays out once when the drag settles, which is both cheaper
 * and what the user sees anyway.
 */
const VIEWPORT_SETTLE_MS = 120;

/**
 * The shortest gap between forwarded mouse moves.
 *
 * Each forwarded event is one request, and a pointer crossing a pane produces
 * a move per pixel. Hover still works — a menu opens, a link underlines — but
 * at a frame's worth of granularity rather than a request per pixel. Presses,
 * releases and wheels are never throttled: dropping one of those loses a click.
 */
const MOUSE_MOVE_MIN_MS = 16;

/** Mouse buttons, as CDP names them. */
const CDP_BUTTONS = ['left', 'middle', 'right', 'back', 'forward'] as const;

/**
 * The modifier bitmask CDP expects: alt 1, ctrl 2, meta 4, shift 8.
 *
 * Not a convenience — a page that checks for ctrl+click, or a text field that
 * expects shift+arrow to extend a selection, sees nothing without it.
 */
function cdpModifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

export interface SessionViewProps {
  /** The browser session whose page this is. */
  session: string;
  /** Bumped by the pane's Refresh, to restart the stream. */
  reloadNonce: number;
  /** Whether this pane currently holds the keyboard. */
  active: boolean;
  zoom: number;
}

export const SessionView = memo(function SessionView({
  session,
  reloadNonce,
  active,
  zoom,
}: SessionViewProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  /** Set by the viewport effect; called again when a frame first arrives. */
  const reportRef = useRef<(() => void) | null>(null);
  const readOnly = useReadOnly();
  const send = useAppSend();

  /**
   * Keep the engine's viewport the size of the pane.
   *
   * A `ResizeObserver` rather than the pane's cell dimensions from props: the
   * page lays out in CSS pixels, and cells are the wrong unit — a pane 80 cells
   * wide is a different pixel width at a different font size. The observer also
   * catches the cases a prop does not, like the window itself changing.
   */
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || readOnly) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastSent = '';

    const report = () => {
      const rect = surface.getBoundingClientRect();
      // The size the page should lay out at, which is the surface divided by
      // zoom: at 2x the user wants things twice as big, which means the page
      // gets half the width and is then scaled up — the same thing a browser's
      // own page zoom does, and the reason text re-wraps rather than being
      // cropped.
      const width = Math.round(rect.width / zoom);
      const height = Math.round(rect.height / zoom);
      // A pane mid-layout reports 0, and a viewport of 0 makes Chromium stop
      // painting — indistinguishable from the feature being broken. The server
      // refuses it too; not sending it keeps a useless round trip off the wire.
      if (width < 16 || height < 16) return;

      const signature = `${width}x${height}@${window.devicePixelRatio}`;
      if (signature === lastSent) return;
      lastSent = signature;

      send({
        type: 'BROWSER_VIEWPORT',
        session,
        width,
        height,
        deviceScaleFactor: window.devicePixelRatio,
      });
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(report, VIEWPORT_SETTLE_MS);
    };

    // Once immediately, so the first paint is the right shape rather than
    // whatever the engine started at. It may not land — see `reassert` below.
    report();
    reportRef.current = () => {
      lastSent = '';
      report();
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(surface);
    return () => {
      clearTimeout(timer);
      reportRef.current = null;
      observer.disconnect();
    };
  }, [session, zoom, readOnly, send]);

  /**
   * Say the size again when the first frame arrives.
   *
   * The mount-time report is sent before the app is necessarily ready to route
   * it, and a dropped one is invisible: the page simply lays out at whatever
   * the engine started with and every later measurement matches what was
   * already sent, so nothing ever corrects it. Observed exactly that way — a
   * pane that looked right until you noticed the page was laid out 1280 wide
   * in a 1377-wide pane.
   *
   * The stream's first frame is the right moment to re-assert it: it is proof
   * the server has this session and is talking to this client, which is the
   * condition the first report was too early for. `lastSent` is cleared first
   * so the re-assert is not suppressed as a duplicate.
   */
  const reassertViewport = useCallback(() => {
    reportRef.current?.();
  }, []);

  /**
   * Where a pointer event landed, in the page's own coordinates.
   *
   * Three transforms stacked: the event is in viewport pixels, the surface is
   * at an offset, and the page is laid out at the surface size divided by zoom.
   * Getting this wrong does not fail loudly — it clicks somewhere else, which
   * is why it is one function rather than repeated at each call site.
   */
  const pagePoint = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const surface = surfaceRef.current;
      if (!surface) return null;
      const rect = surface.getBoundingClientRect();
      return {
        x: Math.round((event.clientX - rect.left) / zoom),
        y: Math.round((event.clientY - rect.top) / zoom),
      };
    },
    [zoom],
  );

  const sendInput = useCallback(
    (method: string, params: Record<string, unknown>) => {
      if (readOnly) return;
      send({ type: 'BROWSER_INPUT', session, method, params });
    },
    [session, readOnly, send],
  );

  const lastMoveRef = useRef(0);

  const onMouse = useCallback(
    (type: 'mousePressed' | 'mouseReleased' | 'mouseMoved') =>
      (event: React.MouseEvent<HTMLDivElement>) => {
        const point = pagePoint(event);
        if (!point) return;
        if (type === 'mouseMoved') {
          const now = performance.now();
          if (now - lastMoveRef.current < MOUSE_MOVE_MIN_MS) return;
          lastMoveRef.current = now;
        }
        // Only a press takes focus and stops here. A move must not call
        // preventDefault — doing so breaks the pane-border drag that
        // `WidgetPane` owns, since the drag is a move sequence over this
        // element's neighbours.
        if (type === 'mousePressed') {
          imageRef.current?.focus({ preventScroll: true });
        }
        sendInput('Input.dispatchMouseEvent', {
          type,
          ...point,
          button: CDP_BUTTONS[event.button] ?? 'left',
          // CDP wants the buttons STILL DOWN, and on a release the browser has
          // already cleared the bit for the one being released, which is the
          // behaviour CDP expects too.
          buttons: event.buttons,
          clickCount: type === 'mouseMoved' ? 0 : event.detail || 1,
          modifiers: cdpModifiers(event),
        });
      },
    [pagePoint, sendInput],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      const point = pagePoint(event);
      if (!point) return;
      // The page scrolls, so the pane must not: without this the scroll
      // bubbles to the pane layout and moves the whole grid instead.
      event.preventDefault();
      sendInput('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        ...point,
        // Inverted sign: a wheel event's deltaY is positive scrolling down,
        // and CDP's deltaY is the distance the CONTENT moves, which is the
        // other way round.
        deltaX: -event.deltaX,
        deltaY: -event.deltaY,
        modifiers: cdpModifiers(event),
      });
    },
    [pagePoint, sendInput],
  );

  if (readOnly) {
    // A viewer is watching someone else's session. The page was fetched from
    // the SERVER's network, so showing it to a viewer would show them a page
    // from hosts they cannot reach — the same reasoning that keeps the file
    // routes off a read-only server (docs/SECURITY.md, SEC-11). The server
    // refuses the route; this says why rather than showing a broken image.
    return (
      <div className="widget-browser-empty" data-testid="browser-session-read-only">
        {session}
        <br />A server-side page is not streamed to a read-only view.
      </div>
    );
  }

  return (
    <div
      ref={surfaceRef}
      className="widget-browser-session"
      data-testid="browser-session"
      data-session={session}
      data-active={active ? 'true' : 'false'}
      onMouseDown={onMouse('mousePressed')}
      onMouseUp={onMouse('mouseReleased')}
      onMouseMove={onMouse('mouseMoved')}
      onWheel={onWheel}
    >
      <img
        ref={imageRef}
        // The key restarts the stream on a refresh: the browser holds one
        // long-lived request per `src`, so re-assigning the same URL does
        // nothing and remounting is what re-requests it.
        key={reloadNonce}
        src={sessionStreamUrl(session, reloadNonce)}
        className="widget-browser-session-frame"
        // The page's own accessible content is on the server; this is a
        // picture of it, so the honest description is what it is a picture of.
        alt={`Live page of browser session ${session}`}
        data-testid="browser-session-frame"
        onLoad={reassertViewport}
        draggable={false}
      />
    </div>
  );
});
