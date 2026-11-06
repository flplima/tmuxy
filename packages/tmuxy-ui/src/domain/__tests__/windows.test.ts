import { describe, it, expect } from 'vitest';
import { selectWindowTarget, stripTabs } from '../windows';
import { modelWindow } from '../../test/model';
import { wid } from '../../test/wire';

const tabs = [
  modelWindow(wid('@1'), 1),
  modelWindow(wid('@2'), 2),
  modelWindow(wid('@7'), 7, { windowType: 'sidebar-left' }),
  modelWindow(wid('@3'), 3),
];

describe('stripTabs', () => {
  it('leaves out sidebars, and a window break-pane has listed before naming it', () => {
    const unnamed = modelWindow(wid('@4'), 4, { name: '' });
    expect(stripTabs([...tabs, unnamed]).map((w) => w.id)).toEqual([
      wid('@1'),
      wid('@2'),
      wid('@3'),
    ]);
  });
});

describe('selectWindowTarget', () => {
  it('steps through the strip both ways, wrapping, past windows it does not show', () => {
    expect(selectWindowTarget('next', tabs, wid('@2'))?.id).toBe(wid('@3'));
    expect(selectWindowTarget('next', tabs, wid('@3'))?.id).toBe(wid('@1'));
    expect(selectWindowTarget('previous', tabs, wid('@1'))?.id).toBe(wid('@3'));
    expect(selectWindowTarget('previous', tabs, wid('@3'))?.id).toBe(wid('@2'));
  });

  it('reads a number as a tmux index and an id as that window', () => {
    expect(selectWindowTarget(3, tabs, wid('@1'))?.id).toBe(wid('@3'));
    expect(selectWindowTarget(wid('@2'), tabs, wid('@1'))?.id).toBe(wid('@2'));
  });

  it('lands nowhere on the current tab or a window the strip does not show', () => {
    expect(selectWindowTarget(wid('@1'), tabs, wid('@1'))).toBeNull();
    expect(selectWindowTarget(7, tabs, wid('@1'))).toBeNull();
    expect(selectWindowTarget('next', tabs, null)).toBeNull();
  });
});
