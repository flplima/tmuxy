import { afterEach, describe, expect, it } from 'vitest';
import { pressMovesWindow } from '../titleBarPress';

/** A status bar as StatusBar renders it, and an app menu drawn into the body beside it. */
function page() {
  document.body.innerHTML = `
    <div class="statusbar">
      <div class="statusbar-inner">
        <button class="app-menu-button">menu</button>
        <div class="tab-list-single"><span class="tab-name" role="tab">demo</span></div>
        <div class="tab-list"><span class="tab-name" role="tab">one</span></div>
        <div class="statusbar-gap"></div>
      </div>
    </div>
    <div class="floating-surface floating-menu" role="menu">
      <div class="floating-menu-item">View</div>
      <div class="floating-menu-gap"></div>
    </div>`;
  const $ = (selector: string) => document.querySelector(selector) as Element;
  return { bar: $('.statusbar'), $ };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('a press the status bar is handed', () => {
  it('moves the window from the bar itself, and from a lone tab, which is a title', () => {
    const { bar, $ } = page();
    expect(pressMovesWindow(bar, $('.statusbar-gap'))).toBe(true);
    expect(pressMovesWindow(bar, $('.tab-list-single .tab-name'))).toBe(true);
  });

  it('leaves the window where it is on a control in the bar', () => {
    const { bar, $ } = page();
    expect(pressMovesWindow(bar, $('.app-menu-button'))).toBe(false);
    expect(pressMovesWindow(bar, $('.tab-list .tab-name'))).toBe(false);
  });

  it('leaves the window where it is on the app menu, which React hands the bar through its portal', () => {
    const { bar, $ } = page();
    expect(pressMovesWindow(bar, $('.floating-menu-item'))).toBe(false);
    expect(pressMovesWindow(bar, $('.floating-menu-gap'))).toBe(false);
  });
});
