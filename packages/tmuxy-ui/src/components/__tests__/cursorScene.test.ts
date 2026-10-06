import { describe, expect, it } from 'vitest';
import { isSceneChange, parseScene, sceneKey } from '../cursorScene';

const at = (window: string, pane: string, group: string | null = null) => ({ window, pane, group });

describe('cursor scene changes', () => {
  it('another tab replaces the picture: no glide', () => {
    expect(isSceneChange(at('@1', '%1'), at('@2', '%5'))).toBe(true);
  });

  it('another member of the same group shown in its place: no glide', () => {
    expect(isSceneChange(at('@1', '%1', 'g1'), at('@1', '%4', 'g1'))).toBe(true);
  });

  it('moving between panes of one tab glides, into or out of a group too', () => {
    expect(isSceneChange(at('@1', '%1'), at('@1', '%2'))).toBe(false);
    expect(isSceneChange(at('@1', '%1', 'g1'), at('@1', '%2'))).toBe(false);
    expect(isSceneChange(at('@1', '%2'), at('@1', '%1', 'g1'))).toBe(false);
    expect(isSceneChange(at('@1', '%1', 'g1'), at('@1', '%7', 'g2'))).toBe(false);
  });

  it('the cursor staying put, or the first scene seen, is not a change', () => {
    expect(isSceneChange(at('@1', '%1', 'g1'), at('@1', '%1', 'g1'))).toBe(false);
    expect(isSceneChange(null, at('@1', '%1'))).toBe(false);
  });

  it('round-trips through its selector key', () => {
    expect(parseScene(sceneKey(at('@1', '%1', 'g1')))).toEqual(at('@1', '%1', 'g1'));
    expect(parseScene(sceneKey({ window: null, pane: null, group: null }))).toEqual({
      window: null,
      pane: null,
      group: null,
    });
  });
});
