/**
 * What a story over real tmux (the v86 tier) waits on instead of a fixed
 * sleep. A sleep encodes how fast tmux, the guest and the runner usually are,
 * and the nightly's history (docs/NIGHTLY-SWEEP.md) is a different story
 * failing each night on a runner slower than usual. Each wait here ends on
 * the state itself, so a slow runner reads as slow, never as done; the story
 * probe's own deadline bounds them.
 *
 * `bin/check-repo-policy.mjs` keeps fixed sleeps out of the v86 story files:
 * `inputPause` is the one way to let time pass there.
 */

/**
 * tmux has done everything sent so far, its notifications are in the app's
 * state and the screen shows it (`window.app.caughtUp`, `AppContext.tsx`).
 * The end of an observation window: a revert, a resurrection or a second
 * flip caused by tmux's answer has happened by then, or never will.
 */
export function tmuxCaughtUp(): Promise<void> {
  return (window as unknown as { app: { caughtUp(): Promise<void> } }).app.caughtUp();
}

/** Every CSS transition under `root` has run to its end (a swap's slide, a resize). */
export async function transitionsDone(root: Element): Promise<void> {
  for (;;) {
    const running = root
      .getAnimations({ subtree: true })
      .filter((a) => a instanceof CSSTransition && a.playState !== 'finished');
    if (running.length === 0) return;
    await Promise.all(running.map((a) => a.finished.catch(() => undefined)));
  }
}

/**
 * A pause BETWEEN INPUT EVENTS, the way a person's hand pauses: the steps of a
 * drag, a pointer resting on a target for the swap dwell. Never to wait for a
 * result — that is `tmuxCaughtUp`, `transitionsDone` or a `waitFor` on what
 * the user would see.
 */
export function inputPause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
