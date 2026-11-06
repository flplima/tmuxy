/**
 * keyboard state — who holds the keyboard (`keyboardOwner`). Every surface
 * that takes or gives it back raises one of these; the keyboard actor follows
 * the result through its view of the context (selectors/keyboard.ts).
 */

export const keyboardGlobalEvents = {
  TAKE_KEYBOARD: { actions: 'keyboard_take' },
  RELEASE_KEYBOARD: { actions: 'keyboard_release' },
  SYNC_FLOAT_FOCUS: { actions: 'keyboard_syncFloatFocus' },
} as const;
