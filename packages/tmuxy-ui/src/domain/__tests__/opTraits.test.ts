/** What the app reads off an op (`opTraits`). */

import { describe, it, expect } from 'vitest';
import { TmuxOp } from '../commands';
import { isMultiStep, isStructural } from '../opTraits';
import { pid, wid } from '../../test/wire';

const S = '$TMUXY_DATA_DIR/bin/tmuxy';

describe('op classification', () => {
  it('flags the ops whose intermediate geometry must not animate', () => {
    expect(isMultiStep(TmuxOp.NewWindow())).toBe(true);
    expect(isMultiStep(TmuxOp.GroupClose({ paneId: pid('%1') }))).toBe(true);
    expect(isMultiStep(TmuxOp.Split({ direction: 'vertical' }))).toBe(false);
    const raw = (command: string) => isMultiStep(TmuxOp.RawCommand({ command }));
    // A raw command (a binding, an essentials alias expanded) by its marker.
    expect(raw(`run-shell "TMUXY_EFFECT=settle bash ${S}/float-create > /dev/null"`)).toBe(true);
    expect(raw(`run-shell "TMUXY_EFFECT=settle ${S}/pane-group next %3"`)).toBe(true);
    expect(raw(`run-shell "TMUXY_EFFECT=relist-windows bash ${S}/stack new %3"`)).toBe(false);
    expect(raw(`run-shell "${S}/pane-group join %3 %1 0"`)).toBe(false);
  });

  it('calls an op structural when the store predicts a layout for it, not a focus pin', () => {
    const move = TmuxOp.MoveWindow({
      windowId: wid('@1'),
      anchorId: wid('@2'),
      placement: 'after',
    });
    expect(isStructural(move)).toBe(true);
    expect(
      isStructural(TmuxOp.GroupSwitch({ clickedPaneId: pid('%1'), visiblePaneId: null })),
    ).toBe(true);
    expect(isStructural(TmuxOp.SelectPane({ paneId: pid('%1') }))).toBe(false);
  });
});
