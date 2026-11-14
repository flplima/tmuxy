/**
 * Shows the jump numbers while their chord is held (`domain/jumpHints.ts`):
 * ctrl alone numbers the tabs, ctrl+alt the panes. They appear only after
 * the chord has been held on its own for `JUMP_HINT_DELAY_MS`, so a ctrl+c
 * or a quick ctrl+2 never flashes them, and they stay up while digits are
 * pressed, so several jumps can be made under one hold.
 *
 * A class on <body>, as `linkModifierActor` does it: the badges are always
 * in the DOM and CSS shows them, so a modifier press re-renders nothing.
 */

import { fromCallback } from 'xstate';
import { jumpDigit, jumpHintMode, type JumpHintMode } from '../../domain/jumpHints';
import { isModifierOnlyKey } from './keyboard/keyFormatting';

export const JUMP_HINT_DELAY_MS = 400;

export const JUMP_HINT_CLASS: Record<JumpHintMode, string> = {
  tabs: 'jump-hints-tabs',
  panes: 'jump-hints-panes',
};

export type JumpHintsActorEvent = { type: 'NOOP' };

export function createJumpHintsActor() {
  return fromCallback<JumpHintsActorEvent>(() => {
    let shown: JumpHintMode | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** Another key was pressed under this hold: no hints until every modifier is up. */
    let spoiled = false;

    const show = (mode: JumpHintMode | null) => {
      if (mode === shown) return;
      if (shown) document.body.classList.remove(JUMP_HINT_CLASS[shown]);
      if (mode) document.body.classList.add(JUMP_HINT_CLASS[mode]);
      shown = mode;
    };
    const wait = (mode: JumpHintMode | null) => {
      if (timer) clearTimeout(timer);
      timer = mode ? setTimeout(() => show(mode), JUMP_HINT_DELAY_MS) : null;
    };
    const reset = () => {
      wait(null);
      show(null);
    };

    const onKey = (event: KeyboardEvent) => {
      const mode = jumpHintMode(event);
      if (!mode) {
        spoiled = false;
        return reset();
      }
      if (!isModifierOnlyKey(event.key)) {
        // A jump under hints already up keeps them; anything else is a
        // shortcut the user knew, and it ends them.
        if (event.type === 'keydown' && !(shown && jumpDigit(event.code))) {
          spoiled = true;
          reset();
        }
        return;
      }
      if (spoiled) return;
      // Pressing or letting go of alt under ctrl switches between the two.
      if (shown) return show(mode);
      wait(mode);
    };

    // A click or a scroll under ctrl (opening a link, zooming) is not a
    // jump either: it ends the hold the way another key does.
    const onPointer = () => {
      if (!shown && !timer) return;
      spoiled = true;
      reset();
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('wheel', onPointer, { capture: true, passive: true });
    // A switch to another app while the chord is down never sees its keyup.
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('wheel', onPointer, true);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
      reset();
    };
  });
}
