import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SPLIT } from '../../domain/phoneSplit';
import { forgetPhoneSplitPref, loadPhoneSplitPref, savePhoneSplitPref } from '../prefs';

describe('the phone split kept per device', () => {
  afterEach(() => localStorage.clear());

  it('comes back as it was left, and as the default once forgotten', () => {
    expect(loadPhoneSplitPref()).toEqual(DEFAULT_SPLIT);
    savePhoneSplitPref({ zoom: 1.75, collapsed: true });
    expect(loadPhoneSplitPref()).toEqual({ zoom: 1.75, collapsed: true });
    forgetPhoneSplitPref();
    expect(loadPhoneSplitPref()).toEqual(DEFAULT_SPLIT);
  });
});
