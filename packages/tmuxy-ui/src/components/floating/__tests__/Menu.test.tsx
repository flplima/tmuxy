import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { FloatingMenu, MenuItem, SubMenu } from '../Menu';

// Animations on, so a closed submenu is held in the DOM for its exit.
vi.mock('../../../machines/appHooks', () => ({ useAppSelector: () => true }));

// jsdom has no Web Animations; the menu only asks which are playing.
Element.prototype.getAnimations ??= () => [];

function appearance(selector: string): Promise<HTMLElement> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const found = document.querySelector<HTMLElement>(selector);
      if (!found) return;
      observer.disconnect();
      resolve(found);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

const press = (key: string) =>
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );

/** Resolves once `element` holds the focus. */
function focusOn(element: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (document.activeElement !== element) return;
      document.removeEventListener('focusin', check);
      resolve();
    };
    document.addEventListener('focusin', check);
    check();
  });
}

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

describe('a submenu opened by hovering its item', () => {
  afterEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('closes one level per Escape even when the keys arrive before React has idled', async () => {
    let closed: () => void = () => {};
    const menuClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const onClose = vi.fn(() => closed());
    render(
      <FloatingMenu id="menu" anchor={{ kind: 'point', x: 0, y: 0 }} onClose={onClose}>
        <MenuItem>New Tab</MenuItem>
        <SubMenu label="Theme">
          <MenuItem>Dark Mode</MenuItem>
          <MenuItem disabled>Gruvbox</MenuItem>
        </SubMenu>
      </FloatingMenu>,
    );

    // Real browser timing from here on: React commits the submenu in one task and
    // runs its effects in a later one, and keys can land in between.
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    const theme = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Theme'),
    )!;
    const column = appearance('[role="menu"][aria-label="Theme"]');
    theme.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    const submenu = await column;

    [...submenu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((el) => el.textContent?.includes('Gruvbox'))!
      .focus();
    press('Escape');
    await focusOn(theme);
    expect(onClose).not.toHaveBeenCalled();
    press('Escape');
    await menuClosed;
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
