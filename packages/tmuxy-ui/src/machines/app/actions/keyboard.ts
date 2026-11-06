import { assignCtx } from '../actionTypes';
import { visibleFloats } from '../../selectors/panesAndSidebars';
import { ownerAfterFloats, PANES_OWN_KEYBOARD } from '../../selectors/keyboard';

export const keyboardActions = {
  keyboard_take: assignCtx(({ event }) =>
    event.type === 'TAKE_KEYBOARD' ? { keyboardOwner: event.owner } : {},
  ),

  keyboard_release: assignCtx(({ context, event }) =>
    event.type === 'RELEASE_KEYBOARD' && context.keyboardOwner.kind === event.from
      ? { keyboardOwner: PANES_OWN_KEYBOARD }
      : {},
  ),

  /**
   * The floats on screen changed: the topmost takes the keyboard when it
   * `claim`s it (it just came into view, or the user switched to its tab),
   * and a float that held it and left the screen hands it on.
   */
  keyboard_syncFloatFocus: assignCtx(({ context, event }) => {
    if (event.type !== 'SYNC_FLOAT_FOCUS') return {};
    const visible = visibleFloats(context.floatPanes, context.windows, context.activeWindowId).map(
      (f) => f.paneId,
    );
    const keyboardOwner = ownerAfterFloats(context.keyboardOwner, visible, event.claim);
    return keyboardOwner === context.keyboardOwner ? {} : { keyboardOwner };
  }),
};
