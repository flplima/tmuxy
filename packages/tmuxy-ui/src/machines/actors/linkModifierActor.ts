/**
 * Link Modifier Actor - tracks whether the platform's "open link" modifier is
 * held (Cmd on macOS, Ctrl elsewhere) and reflects it as a class on <body>.
 *
 * Auto-detected URLs are just text that happens to look like a link, so they
 * stay inert until the user asks for them: the class is what reveals their
 * underline and makes them clickable (see `.terminal-autolink` in styles.css).
 * OSC 8 hyperlinks are declared by the application itself and never depend on
 * this — they are always live.
 *
 * A body class rather than machine context: the affordance flips for every
 * pane at once, and threading it through React would re-render the whole
 * terminal tree on each modifier press.
 */

import { fromCallback } from 'xstate';

export const LINK_MODIFIER_CLASS = 'link-modifier-held';

export type LinkModifierActorEvent = { type: 'NOOP' };

/**
 * Which modifier opens a link on this platform — Cmd on Apple, Ctrl elsewhere,
 * matching the convention every editor and browser uses. Exported so tests
 * press the same key the actor listens for.
 */
export const isApplePlatform = (): boolean =>
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

export function createLinkModifierActor() {
  return fromCallback<LinkModifierActorEvent>(() => {
    const apple = isApplePlatform();
    let held = false;

    const set = (next: boolean) => {
      if (next === held) return;
      held = next;
      document.body.classList.toggle(LINK_MODIFIER_CLASS, next);
    };

    // Reading the modifier off the event (rather than tracking `key === 'Meta'`
    // presses) also recovers the right state for a key released outside the
    // window, and for the modifier being down before the first keydown.
    const onKey = (e: KeyboardEvent) => set(apple ? e.metaKey : e.ctrlKey);
    const clear = () => set(false);

    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    // Cmd+Tab and Cmd+` switch apps while the modifier is still down, so the
    // keyup never arrives and the underline would stay stuck on.
    window.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', clear);

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', clear);
      document.removeEventListener('visibilitychange', clear);
      clear();
    };
  });
}
