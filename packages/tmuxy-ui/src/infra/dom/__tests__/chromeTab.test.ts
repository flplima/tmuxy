import { afterEach, describe, expect, it } from 'vitest';
import { activatesChromeButton, noteFocus } from '../chromeTab';

const MODS = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };

describe('activatesChromeButton', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    noteFocus(null, false);
  });

  const button = () => {
    const el = document.createElement('button');
    document.body.append(el);
    return el;
  };

  it('lets Enter and Space press a button the keyboard reached', () => {
    const target = button();
    expect(activatesChromeButton({ key: 'Enter', ...MODS, target })).toBe(true);
    expect(activatesChromeButton({ key: ' ', ...MODS, target })).toBe(true);
  });

  it('leaves them to the shell after a click, with a modifier, or off a button', () => {
    const target = button();
    noteFocus(target, true);
    expect(activatesChromeButton({ key: 'Enter', ...MODS, target })).toBe(false);
    noteFocus(null, false);
    expect(activatesChromeButton({ key: 'Enter', ...MODS, ctrlKey: true, target })).toBe(false);
    expect(activatesChromeButton({ key: 'a', ...MODS, target })).toBe(false);
    expect(activatesChromeButton({ key: 'Enter', ...MODS, target: document.body })).toBe(false);
  });
});
