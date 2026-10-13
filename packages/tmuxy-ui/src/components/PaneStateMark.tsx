/**
 * The mark a pane's state draws — in the sidebar tree, on a tab, in a pane
 * header. Idle draws nothing: the mark is there to say a pane wants something
 * or is busy, and a mark on every quiet pane drowned the ones that did.
 *
 * Working is the one animated state (motion means "busy, leave it alone",
 * stillness "stopped, it wants you"): a Braille spinner, the same characters
 * the agents put in their own terminal titles. Every spinner on screen steps
 * from one shared clock, so they turn together and only their own text node
 * re-renders.
 */

import { useSyncExternalStore } from 'react';
import { PANE_STATE_GLYPH, PANE_STATE_LABEL, type PaneStateName } from '../utils/paneState';
import { Tooltip } from './Tooltip';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_STEP_MS = 80;
/** Shown instead of the animation with reduced motion: busy, and holding still. */
const SPINNER_STILL = '⠿';

let frame = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= setInterval(() => {
    frame = (frame + 1) % SPINNER_FRAMES.length;
    listeners.forEach((l) => l());
  }, SPINNER_STEP_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const getFrame = () => frame;
const stayStill = () => () => {};

function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function Spinner() {
  const still = reducedMotion();
  const current = useSyncExternalStore(still ? stayStill : subscribe, getFrame);
  return <>{still ? SPINNER_STILL : SPINNER_FRAMES[current]}</>;
}

/**
 * `className` places the mark (`sidebar-tree-state`, `tab-mark`, …) and
 * `is-<state>` colours it. `keepSpace` holds an idle mark's box empty, for a
 * column of marks that has to stay aligned.
 */
export function PaneStateMark({
  state,
  className,
  keepSpace = false,
}: {
  state: PaneStateName;
  className: string;
  keepSpace?: boolean;
}) {
  if (state === 'idle') {
    return keepSpace ? <span className={className} aria-hidden="true" /> : null;
  }
  const label = PANE_STATE_LABEL[state];
  return (
    <Tooltip label={label}>
      <span className={`${className} is-${state}`} role="img" aria-label={label}>
        {state === 'working' ? <Spinner /> : PANE_STATE_GLYPH[state]}
      </span>
    </Tooltip>
  );
}
